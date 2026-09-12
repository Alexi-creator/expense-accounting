import type { CurrencyService } from './currency.service';
import {
  aggregateSummary,
  bucketKey,
  buildBuckets,
  resolveSummaryRange,
  type SummaryRow,
} from './summary.util';

// Dates are built with the local constructor so getFullYear/Month/Date are deterministic.
// 2026-06-15 is a Monday; 2026-06-17 a Wednesday.
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe('summary.util', () => {
  describe('bucketKey', () => {
    it('formats a day key as YYYY-MM-DD', () => {
      expect(bucketKey(d(2026, 6, 15), 'day')).toBe('2026-06-15');
      expect(bucketKey(d(2026, 1, 5), 'day')).toBe('2026-01-05');
    });

    it('formats a month key as YYYY-MM', () => {
      expect(bucketKey(d(2026, 6, 17), 'month')).toBe('2026-06');
    });

    it('snaps a week key to the Monday of that week', () => {
      expect(bucketKey(d(2026, 6, 15), 'week')).toBe('2026-06-15'); // Monday itself
      expect(bucketKey(d(2026, 6, 17), 'week')).toBe('2026-06-15'); // Wednesday → back to Monday
    });
  });

  describe('buildBuckets', () => {
    it('lists every day in the inclusive range', () => {
      expect(buildBuckets(d(2026, 6, 1), d(2026, 6, 3), 'day')).toEqual([
        '2026-06-01',
        '2026-06-02',
        '2026-06-03',
      ]);
    });

    it('lists every month in the inclusive range', () => {
      expect(buildBuckets(d(2026, 1, 15), d(2026, 3, 2), 'month')).toEqual([
        '2026-01',
        '2026-02',
        '2026-03',
      ]);
    });

    it('lists week-start Mondays across the range', () => {
      expect(buildBuckets(d(2026, 6, 15), d(2026, 6, 29), 'week')).toEqual([
        '2026-06-15',
        '2026-06-22',
        '2026-06-29',
      ]);
    });
  });

  describe('resolveSummaryRange', () => {
    it('defaults to the current month with monthly granularity', () => {
      const { granularity } = resolveSummaryRange({});
      expect(granularity).toBe('month');
    });

    it('honours explicit from/to/granularity', () => {
      const r = resolveSummaryRange({ from: '2026-06-01', to: '2026-06-30', granularity: 'day' });
      expect(r.granularity).toBe('day');
      expect(r.from.getUTCFullYear()).toBe(2026);
    });

    it('falls back to month for an invalid granularity', () => {
      expect(resolveSummaryRange({ granularity: 'nonsense' }).granularity).toBe('month');
    });
  });

  describe('aggregateSummary', () => {
    // Stub: aggregateSummary only calls historicalTotalInBase; return a sentinel.
    const currency = {
      historicalTotalInBase: jest.fn().mockReturnValue(999),
    } as unknown as CurrencyService;
    // Stand-in resolver — the stub above never consults it.
    const rateAt = () => 1;

    const rows: SummaryRow[] = [
      { amount: 10, amountUsd: 10, currency: 'USD', date: d(2026, 6, 15) },
      { amount: 5, amountUsd: 5, currency: 'USD', date: d(2026, 6, 15) },
      { amount: 90, amountUsd: 100, currency: 'EUR', date: d(2026, 6, 15) },
    ];

    it('groups per currency within a bucket without summing across currencies', () => {
      const result = aggregateSummary(rows, ['2026-06-15'], 'day', 'USD', rateAt, currency);
      const bucket = result.buckets[0];

      const usd = bucket.totals.find((t) => t.currency === 'USD');
      const eur = bucket.totals.find((t) => t.currency === 'EUR');
      expect(usd).toEqual({ currency: 'USD', total: 15, count: 2 });
      expect(eur).toEqual({ currency: 'EUR', total: 90, count: 1 });
      expect(bucket.approxTotal).toBe(999);
    });

    it('emits empty buckets for keys with no rows', () => {
      const result = aggregateSummary(
        rows,
        ['2026-06-14', '2026-06-15'],
        'day',
        'USD',
        rateAt,
        currency,
      );
      expect(result.buckets[0]).toMatchObject({ bucket: '2026-06-14', totals: [] });
      expect(result.buckets[1].totals.length).toBe(2);
    });

    it('reports the chosen base currency and granularity', () => {
      const result = aggregateSummary(rows, ['2026-06-15'], 'day', 'EUR', rateAt, currency);
      expect(result.baseCurrency).toBe('EUR');
      expect(result.granularity).toBe('day');
    });
  });
});
