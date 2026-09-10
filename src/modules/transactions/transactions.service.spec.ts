import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { GoalsService } from '../goals/goals.service';
import { TransactionsService } from './transactions.service';

// rates[X] = units of X per 1 USD.
const RATES = { EUR: 0.9, THB: 32 };

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: {
    $queryRaw: jest.Mock;
    income: { groupBy: jest.Mock };
    expense: { groupBy: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let currency: {
    getRates: jest.Mock;
    approxTotalInBase: jest.Mock;
    usdToBase: jest.Mock;
    convertWithRates: jest.Mock;
  };
  let goals: { reservedRows: jest.Mock };
  let exchanges: { movementsByCurrency: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn(),
      income: { groupBy: jest.fn() },
      expense: { groupBy: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ currency: 'USD' }) },
    };
    currency = {
      getRates: jest.fn().mockResolvedValue(RATES),
      approxTotalInBase: jest.fn(),
      usdToBase: jest.fn(),
      // The real pure implementation: the balance is arithmetic, and mocking it away is exactly
      // what let the old rounding bug hide.
      convertWithRates: jest.fn((rates, amount, from, to) =>
        from === to
          ? amount
          : (amount / (from === 'USD' ? 1 : rates[from])) * (to === 'USD' ? 1 : rates[to]),
      ),
    };
    goals = { reservedRows: jest.fn().mockResolvedValue([]) };
    exchanges = { movementsByCurrency: jest.fn().mockResolvedValue([]) };

    const module = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
        { provide: GoalsService, useValue: goals },
        { provide: ExchangesService, useValue: exchanges },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('findAll', () => {
    it('paginates and summarizes income/expense/net over the current page (items)', async () => {
      // Raw queries, in call order: items, count.
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'i1', type: 'income', currency: 'USD', amount: 200, amountUsd: 200 },
          { id: 'e1', type: 'expense', currency: 'USD', amount: 50, amountUsd: 50 },
        ])
        .mockResolvedValueOnce([{ count: 12n }]);
      // approxTotalInBase order: income first, then expense.
      currency.approxTotalInBase.mockReturnValueOnce(200).mockReturnValueOnce(50);

      const res = await service.findAll('u1', { page: 2, limit: 5 });

      expect(res.total).toBe(12);
      expect(res.page).toBe(2);
      expect(res.limit).toBe(5);
      expect(res.totalPages).toBe(3); // ceil(12 / 5)
      expect(res.summary).toEqual({ baseCurrency: 'USD', income: 200, expense: 50, net: 150 });
      // The summary is derived from the page rows, split by type.
      expect(currency.approxTotalInBase).toHaveBeenNthCalledWith(
        1,
        [{ id: 'i1', type: 'income', currency: 'USD', amount: 200, amountUsd: 200 }],
        'USD',
        RATES,
      );
      expect(currency.approxTotalInBase).toHaveBeenNthCalledWith(
        2,
        [{ id: 'e1', type: 'expense', currency: 'USD', amount: 50, amountUsd: 50 }],
        'USD',
        RATES,
      );
      // amountUsd is internal and must not leak into the response items.
      expect(res.items).toEqual([
        { id: 'i1', type: 'income', currency: 'USD', amount: 200 },
        { id: 'e1', type: 'expense', currency: 'USD', amount: 50 },
      ]);
    });

    it('reports net=null when a total could not be computed (rates unavailable)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      currency.approxTotalInBase.mockReturnValueOnce(null).mockReturnValueOnce(50);

      const res = await service.findAll('u1', {});

      expect(res.summary.net).toBeNull();
      expect(res.page).toBe(1);
      expect(res.limit).toBe(20);
    });
  });

  describe('getBalance', () => {
    const groups = (rows: [string, number][]) =>
      rows.map(([currency, amount]) => ({ currency, _sum: { amount } }));

    it('sums each currency exactly and converts only what is held in another one', async () => {
      prisma.income.groupBy.mockResolvedValue(
        groups([
          ['THB', 1_000_000],
          ['USD', 500],
        ]),
      );
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 950_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });

      const res = await service.getBalance('u1');

      // THB rows are summed as THB, never routed through USD and back.
      expect(res.byCurrency).toEqual([
        { currency: 'THB', amount: 50_000 },
        { currency: 'USD', amount: 500 },
      ]);
      // 50 000 THB exactly + 500 USD at 32.
      expect(res.balance).toBe(66_000);
      expect(res.isApproximate).toBe(true);
    });

    it('is exact and rate-independent for a single-currency ledger', async () => {
      // The regression this rewrite exists for: with everything in THB, the old code converted
      // each row to USD at its own historical rate and the net back at today's rate, so a rate
      // move turned +5 000 THB into a different number entirely.
      prisma.income.groupBy.mockResolvedValue(groups([['THB', 1_000_000]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 995_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });
      currency.getRates.mockResolvedValue(null); // rates API down — must not matter

      const res = await service.getBalance('u1');

      expect(res.balance).toBe(5_000);
      expect(res.byCurrency).toEqual([{ currency: 'THB', amount: 5_000 }]);
      expect(res.isApproximate).toBe(false);
      // Nothing needed converting, so nothing was converted.
      expect(currency.convertWithRates).not.toHaveBeenCalled();
    });

    it('never applies a conversion spread to money that was never converted', async () => {
      prisma.income.groupBy.mockResolvedValue(groups([['THB', 300_000]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 250_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });

      const res = await service.getBalance('u1');

      // 50 000 exactly — not 50 000 minus 2% of the 550 000 turnover.
      expect(res.balance).toBe(50_000);
    });

    it('subtracts goal reserves from the free balance of their own currency', async () => {
      prisma.income.groupBy.mockResolvedValue(groups([['THB', 100_000]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 20_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });
      goals.reservedRows.mockResolvedValue([{ currency: 'THB', amount: 30_000, amountUsd: null }]);

      const res = await service.getBalance('u1');

      expect(res.balance).toBe(50_000);
      expect(res.byCurrency).toEqual([{ currency: 'THB', amount: 50_000 }]);
      expect(res.inGoals).toBe(30_000);
    });

    it('converts the base-currency total into USD, rather than aggregating twice', async () => {
      prisma.income.groupBy.mockResolvedValue(groups([['EUR', 200]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['EUR', 50]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'EUR' });

      const res = await service.getBalance('u1');

      expect(res.balance).toBe(150);
      expect(res.balanceUsd).toBe(166.67); // 150 / 0.9
    });

    it('skips conversion entirely when the base currency already is USD', async () => {
      prisma.income.groupBy.mockResolvedValue(groups([['USD', 200]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['USD', 50]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'USD' });

      const res = await service.getBalance('u1');

      expect(res).toMatchObject({ baseCurrency: 'USD', balance: 150, balanceUsd: 150 });
      expect(currency.convertWithRates).not.toHaveBeenCalled();
    });

    it('reports null instead of a guess when a foreign holding cannot be converted', async () => {
      prisma.income.groupBy.mockResolvedValue(
        groups([
          ['THB', 100_000],
          ['USD', 500],
        ]),
      );
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 20_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });
      currency.getRates.mockResolvedValue(null);

      const res = await service.getBalance('u1');

      expect(res.balance).toBeNull();
      expect(res.balanceUsd).toBeNull();
      // The exact per-currency figures still stand — they never needed a rate.
      expect(res.byCurrency).toEqual([
        { currency: 'THB', amount: 80_000 },
        { currency: 'USD', amount: 500 },
      ]);
    });

    it('moves money between currencies on a recorded exchange, with no rate of ours', async () => {
      prisma.income.groupBy.mockResolvedValue(groups([['THB', 100_000]]));
      prisma.expense.groupBy.mockResolvedValue(groups([['THB', 20_000]]));
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });
      // Handed over 100 USD, got 3 180 THB at the counter.
      exchanges.movementsByCurrency.mockResolvedValue([
        { currency: 'USD', amount: -100 },
        { currency: 'THB', amount: 3_180 },
      ]);

      const res = await service.getBalance('u1');

      // The USD side is spent down to -100 (money the user no longer holds), THB is up by exactly
      // what was received — not by 100 x today's rate.
      expect(res.byCurrency).toEqual([
        { currency: 'THB', amount: 83_180 },
        { currency: 'USD', amount: -100 },
      ]);
    });

    it('always lists the base currency, even at zero', async () => {
      prisma.income.groupBy.mockResolvedValue([]);
      prisma.expense.groupBy.mockResolvedValue([]);
      prisma.user.findUnique.mockResolvedValue({ currency: 'THB' });

      const res = await service.getBalance('u1');

      expect(res.byCurrency).toEqual([{ currency: 'THB', amount: 0 }]);
      expect(res.balance).toBe(0);
      expect(res.isApproximate).toBe(false);
    });
  });
});
