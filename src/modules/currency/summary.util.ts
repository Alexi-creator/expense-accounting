import type { CurrencyService } from './currency.service';

type Rates = Record<string, number>;

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

function normalizeGranularity(value?: string): Granularity | undefined {
  return value === 'day' || value === 'week' || value === 'month' ? value : undefined;
}

// Summary by buckets with a per-currency breakdown (currencies are not summed) + an approx. total
// in the base currency via the USD snapshot. Same logic for expenses and incomes.
export function aggregateSummary(
  rows: SummaryRow[],
  bucketKeys: string[],
  granularity: Granularity,
  baseCurrency: string,
  rates: Rates | null,
  currency: CurrencyService,
) {
  type Acc = { amount: number; count: number; usdSum: number; hasUsd: boolean };
  // bucket -> currency -> accumulator
  const byBucket = new Map<string, Map<string, Acc>>();

  for (const r of rows) {
    const key = bucketKey(r.date, granularity);
    let curMap = byBucket.get(key);
    if (!curMap) {
      curMap = new Map();
      byBucket.set(key, curMap);
    }
    let acc = curMap.get(r.currency);
    if (!acc) {
      acc = { amount: 0, count: 0, usdSum: 0, hasUsd: false };
      curMap.set(r.currency, acc);
    }
    acc.amount += Number(r.amount);
    acc.count += 1;
    // amountUsd === null if the row has no snapshot — then approx falls back to the rate.
    if (r.amountUsd != null) {
      acc.usdSum += Number(r.amountUsd);
      acc.hasUsd = true;
    }
  }

  // All groups for the period — for the approx. total in a single conversion.
  const allGroups: { currency: string; amount: number; amountUsd: number | null }[] = [];

  const buckets = bucketKeys.map((bucket) => {
    const curMap = byBucket.get(bucket);
    const groups = curMap
      ? [...curMap.entries()].map(([cur, a]) => ({
          currency: cur,
          amount: round2(a.amount),
          count: a.count,
          amountUsd: a.hasUsd ? a.usdSum : null,
        }))
      : [];
    allGroups.push(...groups);
    return {
      bucket,
      totals: groups.map((g) => ({ currency: g.currency, total: g.amount, count: g.count })),
      approxTotal: currency.approxTotalInBase(groups, baseCurrency, rates),
    };
  });

  return {
    baseCurrency,
    granularity,
    total: currency.approxTotalInBase(allGroups, baseCurrency, rates),
    buckets,
  };
}
