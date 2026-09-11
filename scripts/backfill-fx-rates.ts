/**
 * Fills `fx_rates` with daily USD rates covering every transaction already on record, then
 * re-snapshots each income/expense at the rate of its own operation date.
 *
 * Needed once, because `amount_usd` used to be captured at the rate of the day the row was
 * typed in — so anything entered after the fact was valued at the wrong rate. Safe to re-run:
 * rates already on record are kept, and re-snapshotting is idempotent.
 *
 *   docker compose run --rm app bun scripts/backfill-fx-rates.ts
 *   ... --dry-run    to see what would change without writing
 */
import { PrismaClient } from '@prisma/client';

const HISTORY_ENDPOINT = 'https://api.frankfurter.dev/v1';
const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (d: Date) => new Date(`${isoDay(d)}T00:00:00Z`);

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  // 1. The date range and the currencies that actually appear in the data.
  const [incomes, expenses] = await Promise.all([
    prisma.income.findMany({ select: { date: true, currency: true } }),
    prisma.expense.findMany({ select: { date: true, currency: true } }),
  ]);
  const rows = [...incomes, ...expenses];
  if (rows.length === 0) {
    console.log('No transactions — nothing to backfill.');
    return;
  }

  const dates = rows.map((r) => r.date.getTime());
  const from = toDay(new Date(Math.min(...dates)));
  const to = toDay(new Date());
  const used = [...new Set(rows.map((r) => r.currency))];

  const available = Object.keys(
    await fetchJson<Record<string, string>>(`${HISTORY_ENDPOINT}/currencies`),
  );
  const wanted = used.filter((c) => c !== 'USD' && available.includes(c));
  const missing = used.filter((c) => c !== 'USD' && !available.includes(c));
  if (missing.length) {
    console.warn(
      `No history available for ${missing.join(', ')} — those rows keep the rate they have.`,
    );
  }

  console.log(`Range ${isoDay(from)} .. ${isoDay(to)}, currencies: ${wanted.join(', ') || '(none)'}`);

  // 2. Pull the daily series and store it. Existing rows win: a day captured live is closer to
  // what the user actually saw than the ECB reference rate.
  if (wanted.length) {
    const url = `${HISTORY_ENDPOINT}/${isoDay(from)}..${isoDay(to)}?base=USD&symbols=${wanted.join(',')}`;
    const data = await fetchJson<{ rates: Record<string, Record<string, number>> }>(url);
    const records = Object.entries(data.rates).flatMap(([day, rates]) =>
      Object.entries(rates).map(([currency, rate]) => ({
        date: new Date(`${day}T00:00:00Z`),
        currency,
        rate,
        source: 'frankfurter',
      })),
    );
    console.log(`${records.length} rate rows fetched`);
    if (!dryRun) {
      const { count } = await prisma.fxRate.createMany({ data: records, skipDuplicates: true });
      console.log(`${count} new rate rows written (${records.length - count} already on record)`);
    }
  }

  // 3. Re-snapshot every transaction at the rate of its own date.
  // The rate for a date is the newest row not later than it (weekends and holidays have none).
  const rateFor = new Map<string, number>();
  const rateOn = async (currency: string, date: Date): Promise<number | null> => {
    if (currency === 'USD') return 1;
    const key = `${currency}@${isoDay(date)}`;
    const cached = rateFor.get(key);
    if (cached !== undefined) return cached;
    const row = await prisma.fxRate.findFirst({
      where: { currency, date: { lte: toDay(date) } },
      orderBy: { date: 'desc' },
      select: { rate: true },
    });
    if (!row) return null;
    const rate = Number(row.rate);
    rateFor.set(key, rate);
    return rate;
  };

  for (const [model, list] of [
    ['income', incomes],
    ['expense', expenses],
  ] as const) {
    const all = await (model === 'income'
      ? prisma.income.findMany({ select: { id: true, amount: true, currency: true, date: true, amountUsd: true } })
      : prisma.expense.findMany({ select: { id: true, amount: true, currency: true, date: true, amountUsd: true } }));

    let changed = 0;
    for (const row of all) {
      const rate = await rateOn(row.currency, row.date);
      if (rate === null) continue;
      const amountUsd = Math.round((Number(row.amount) / rate) * 100) / 100;
      if (row.amountUsd !== null && Math.abs(Number(row.amountUsd) - amountUsd) < 0.005) continue;
      changed += 1;
      if (!dryRun) {
        await (model === 'income'
          ? prisma.income.update({ where: { id: row.id }, data: { amountUsd } })
          : prisma.expense.update({ where: { id: row.id }, data: { amountUsd } }));
      }
    }
    console.log(`${model}: ${changed} of ${list.length} snapshots ${dryRun ? 'would be' : ''} corrected`);
  }

  if (dryRun) console.log('\nDry run — nothing was written.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
