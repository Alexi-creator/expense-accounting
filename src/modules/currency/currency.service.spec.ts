import { CurrencyService } from './currency.service';

// rates[X] = units of X per 1 USD.
const RATES = { EUR: 0.9, THB: 35 };

const makeService = () => new CurrencyService();

describe('CurrencyService', () => {
  describe('convertWithRates', () => {
    const service = makeService();

    it('returns the amount unchanged for the same currency', () => {
      expect(service.convertWithRates(RATES, 100, 'EUR', 'EUR')).toBe(100);
    });

    it('converts to and from the USD base', () => {
      expect(service.convertWithRates(RATES, 100, 'USD', 'EUR')).toBe(90);
      expect(service.convertWithRates(RATES, 90, 'EUR', 'USD')).toBe(100);
    });

    it('converts between two non-base currencies via USD', () => {
      // 35 THB = 1 USD = 0.9 EUR
      expect(service.convertWithRates(RATES, 35, 'THB', 'EUR')).toBeCloseTo(0.9);
    });

    it('returns null for an unknown currency', () => {
      expect(service.convertWithRates(RATES, 1, 'XXX', 'USD')).toBeNull();
      expect(service.convertWithRates(RATES, 1, 'USD', 'XXX')).toBeNull();
    });
  });

  describe('convert', () => {
    it('short-circuits same-currency without fetching rates', async () => {
      const service = makeService();
      const spy = jest.spyOn(service, 'getRates');
      await expect(service.convert(100, 'USD', 'USD')).resolves.toBe(100);
      expect(spy).not.toHaveBeenCalled();
    });

    it('uses the fetched rates for a real conversion', async () => {
      const service = makeService();
      jest.spyOn(service, 'getRates').mockResolvedValue(RATES);
      await expect(service.convert(100, 'USD', 'EUR')).resolves.toBe(90);
    });

    it('returns null when rates are unavailable', async () => {
      const service = makeService();
      jest.spyOn(service, 'getRates').mockResolvedValue(null);
      await expect(service.convert(100, 'USD', 'EUR')).resolves.toBeNull();
    });
  });

  describe('sumUsd', () => {
    const service = makeService();

    it('returns 0 for no rows (without needing rates)', () => {
      expect(service.sumUsd([], null)).toBe(0);
    });

    it('uses the amountUsd snapshot when present, else the current rate', () => {
      const rows = [
        { amount: 100, currency: 'USD', amountUsd: 100 },
        { amount: 90, currency: 'EUR', amountUsd: null }, // no snapshot → convert 90 EUR = 100 USD
      ];
      expect(service.sumUsd(rows, RATES)).toBe(200);
    });

    it('returns null when a snapshotless row needs unavailable rates', () => {
      const rows = [{ amount: 90, currency: 'EUR', amountUsd: null }];
      expect(service.sumUsd(rows, null)).toBeNull();
    });
  });

  describe('approxTotalInBase', () => {
    it('takes base-currency rows as-is, no rates needed', () => {
      const service = makeService();
      const rows = [{ amount: 50, currency: 'EUR', amountUsd: null }];
      expect(service.approxTotalInBase(rows, 'EUR', null)).toBe(50);
    });

    it('converts cross-currency rows via the USD snapshot', () => {
      const service = makeService();
      const rows = [{ amount: 90, currency: 'EUR', amountUsd: 95 }];
      // snapshot 95 USD, base USD -> 95
      expect(service.approxTotalInBase(rows, 'USD', RATES)).toBe(95);
    });

    it('never invents a conversion cost: totals are mid-market', () => {
      const service = makeService();
      const rows = [{ amount: 90, currency: 'EUR', amountUsd: 100 }];
      // The same row is worth the same whether it is an expense or an income — a spread belongs
      // to a real exchange the user records, not to every cross-currency row.
      expect(service.approxTotalInBase(rows, 'USD', RATES)).toBe(100);
    });

    it('sums rows of several currencies, base ones untouched', () => {
      const service = makeService();
      const rows = [
        { amount: 1000, currency: 'THB', amountUsd: null },
        { amount: 100, currency: 'USD', amountUsd: 100 },
      ];
      // THB 1000 / 35 = 28.57 USD, plus the 100 USD row taken as-is.
      expect(service.approxTotalInBase(rows, 'USD', RATES)).toBe(128.57);
    });

    it('returns null when a cross-currency row without a snapshot needs missing rates', () => {
      const service = makeService();
      const rows = [{ amount: 90, currency: 'EUR', amountUsd: null }];
      expect(service.approxTotalInBase(rows, 'USD', null)).toBeNull();
    });
  });

  describe('historicalTotalInBase', () => {
    const MARCH = new Date('2025-03-10T00:00:00Z');
    const TODAY = new Date('2026-09-10T00:00:00Z');
    // A base currency that has lost value: 1 USD bought 1 000 of it in March, 1 400 now.
    const rateAt = (currency: string, date: Date) => {
      if (currency === 'USD') return 1;
      if (currency !== 'ARS') return null;
      return date.getTime() <= MARCH.getTime() ? 1000 : 1400;
    };

    it('values a row at its own date, not at the newest rate', () => {
      const service = makeService();
      const march = [{ amount: 100, currency: 'USD', amountUsd: 100, date: MARCH }];
      // 100 USD spent in March was worth 100 000, and stays worth 100 000 however far the rate
      // moves afterwards. Valuing it at today's rate would inflate it to 140 000 instead.
      expect(service.historicalTotalInBase(march, 'ARS', rateAt)).toBe(100000);
      const today = [{ amount: 100, currency: 'USD', amountUsd: 100, date: TODAY }];
      expect(service.historicalTotalInBase(today, 'ARS', rateAt)).toBe(140000);
    });

    it('takes base-currency rows as they are, without consulting a rate', () => {
      const service = makeService();
      const rows = [{ amount: 50, currency: 'EUR', amountUsd: 55, date: MARCH }];
      const never = () => {
        throw new Error('no rate should be needed');
      };
      expect(service.historicalTotalInBase(rows, 'EUR', never)).toBe(50);
    });

    it('values a row with no USD snapshot at its own date too', () => {
      const service = makeService();
      // Legacy row, no amountUsd: ARS 100 000 in March was 100 USD, and the base is USD.
      const rows = [{ amount: 100000, currency: 'ARS', amountUsd: null, date: MARCH }];
      expect(service.historicalTotalInBase(rows, 'USD', rateAt)).toBe(100);
    });

    it('sums rows of several dates, each at the rate that held then', () => {
      const service = makeService();
      const rows = [
        { amount: 100, currency: 'USD', amountUsd: 100, date: MARCH },
        { amount: 100, currency: 'USD', amountUsd: 100, date: TODAY },
      ];
      expect(service.historicalTotalInBase(rows, 'ARS', rateAt)).toBe(240000);
    });

    it('returns null when the base currency rate is unknown for a row', () => {
      const service = makeService();
      const rows = [{ amount: 100, currency: 'USD', amountUsd: 100, date: MARCH }];
      expect(service.historicalTotalInBase(rows, 'XXX', () => null)).toBeNull();
    });
  });
});
