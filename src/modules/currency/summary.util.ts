import type { CurrencyService, DatedRow, RateAt } from './currency.service';

export type Granularity = 'day' | 'week' | 'month';

// An operation row, sufficient for aggregating the summary.
export type SummaryRow = {
  amount: unknown; // Prisma Decimal
  amountUsd: unknown | null;
  currency: string;
  date: Date;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const pad = (n: number) => String(n).padStart(2, '0');

const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// The Monday of the week the date falls into (start of the week bucket).
const weekStart = (d: Date) => {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (r.getDay() + 6) % 7; // 0 = Monday
  r.setDate(r.getDate() - dow);
  return r;
};

// Bucket key: day — YYYY-MM-DD, week — YYYY-MM-DD of its Monday, month — YYYY-MM.
export function bucketKey(d: Date, granularity: Granularity): string {
  if (granularity === 'day') return dayKey(d);
  if (granularity === 'week') return dayKey(weekStart(d));
  return monthKey(d);
}

// Keys of all buckets in the range [from, to] inclusive, ascending.
export function buildBuckets(from: Date, to: Date, granularity: Granularity): string[] {
  const cursor =
    granularity === 'month'
      ? new Date(from.getFullYear(), from.getMonth(), 1)
      : granularity === 'week'
        ? weekStart(from)
        : new Date(from.getFullYear(), from.getMonth(), from.getDate());

  const keys: string[] = [];
  while (cursor <= to) {
    keys.push(bucketKey(cursor, granularity));
    if (granularity === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else if (granularity === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

// Parse /summary params: the from/to range + granularity.
// Defaults to the current month with monthly buckets.
export function resolveSummaryRange(params: { from?: string; to?: string; granularity?: string }): {
  from: Date;
  to: Date;
  granularity: Granularity;
} {
  const granularity = normalizeGranularity(params.granularity) ?? 'month';
  const to = params.to ? new Date(params.to) : new Date();
  const from = params.from ? new Date(params.from) : new Date(to.getFullYear(), to.getMonth(), 1);
  return { from, to, granularity };
}

// Inclusive `to` bound for a civil date param: the end of that day in wall-clock (UTC) components,
// so a plain YYYY-MM-DD keeps that whole day's operations instead of cutting at midnight.
export function endOfDay(value: string): Date {
  const d = new Date(value);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Earliest of the given range bounds; undefined if any of them is open, since an open bound
 * reaches back as far as the rows do. Used to size the span of rates a report has to load.
 */
export function earliest(...bounds: (Date | undefined)[]): Date | undefined {
  if (bounds.some((d) => d === undefined)) return undefined;
  return new Date(Math.min(...bounds.map((d) => (d as Date).getTime())));
}

/** Latest of the given range bounds, never earlier than today — the other edge of that span. */
export function latest(...bounds: (Date | undefined)[]): Date {
  const times = bounds.filter((d): d is Date => d !== undefined).map((d) => d.getTime());
  return new Date(Math.max(Date.now(), ...times));
}

function normalizeGranularity(value?: string): Granularity | undefined {
  return value === 'day' || value === 'week' || value === 'month' ? value : undefined;
}

// Summary by buckets with a per-currency breakdown (currencies are not summed) + an approx. total
// in the base currency. Same logic for expenses and incomes.
//
// Every row is valued at the rate of its own date, so a bucket that has closed keeps the figure it
// had: re-opening last March never shows a different number than last March did.
export function aggregateSummary(
  rows: SummaryRow[],
  bucketKeys: string[],
  granularity: Granularity,
  baseCurrency: string,
  rateAt: RateAt,
  currency: CurrencyService,
) {
  type Acc = { amount: number; count: number };
  // bucket -> the bucket's rows (for the base-currency total) + its per-currency breakdown.
  const byBucket = new Map<string, { rows: DatedRow[]; byCurrency: Map<string, Acc> }>();

  for (const r of rows) {
    const key = bucketKey(r.date, granularity);
    let bucket = byBucket.get(key);
    if (!bucket) {
      bucket = { rows: [], byCurrency: new Map() };
      byBucket.set(key, bucket);
    }
    const amount = Number(r.amount);
    // amountUsd === null if the row has no snapshot — then the row's own date's rate is used.
    bucket.rows.push({
      amount,
      currency: r.currency,
      amountUsd: r.amountUsd == null ? null : Number(r.amountUsd),
      date: r.date,
    });
    const acc = bucket.byCurrency.get(r.currency) ?? { amount: 0, count: 0 };
    acc.amount += amount;
    acc.count += 1;
    bucket.byCurrency.set(r.currency, acc);
  }

  // All rows of the period — for the total, aggregated once rather than summed from the buckets.
  const allRows: DatedRow[] = [];

  const buckets = bucketKeys.map((bucket) => {
    const entry = byBucket.get(bucket);
    if (entry) allRows.push(...entry.rows);
    return {
      bucket,
      totals: entry
        ? [...entry.byCurrency.entries()].map(([cur, a]) => ({
            currency: cur,
            total: round2(a.amount),
            count: a.count,
          }))
        : [],
      approxTotal: currency.historicalTotalInBase(entry?.rows ?? [], baseCurrency, rateAt),
    };
  });

  return {
    baseCurrency,
    granularity,
    total: currency.historicalTotalInBase(allRows, baseCurrency, rateAt),
    buckets,
  };
}
