import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ExpenseCategoriesService } from './expense-categories.service';

// Stand-in for the rate resolver FxRatesService hands back for the reported range.
const RATE_AT = () => 1;

describe('ExpenseCategoriesService', () => {
  let service: ExpenseCategoriesService;
  let prisma: {
    expenseCategory: { findMany: jest.Mock; findFirst: jest.Mock; delete: jest.Mock };
    expense: { groupBy: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let currency: { getRates: jest.Mock; historicalTotalInBase: jest.Mock };
  let fx: { resolverFor: jest.Mock };

  beforeEach(async () => {
    prisma = {
      expenseCategory: { findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
      expense: { groupBy: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    currency = { getRates: jest.fn().mockResolvedValue({}), historicalTotalInBase: jest.fn() };
    fx = { resolverFor: jest.fn().mockResolvedValue(RATE_AT) };

    const module = await Test.createTestingModule({
      providers: [
        ExpenseCategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
        { provide: FxRatesService, useValue: fx },
        { provide: SubscriptionsService, useValue: { assertCanAddCategory: jest.fn() } },
      ],
    }).compile();

    service = module.get(ExpenseCategoriesService);
  });

  describe('findOne', () => {
    it('throws NotFoundException when missing or not owned', async () => {
      prisma.expenseCategory.findFirst.mockResolvedValue(null);
      await expect(service.findOne('c1', 'u1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('statsByCategory', () => {
    beforeEach(() => {
      prisma.expenseCategory.findMany.mockResolvedValue([{ id: 'c1', name: 'Food', emoji: '🍔' }]);
      prisma.user.findUnique.mockResolvedValue({ currency: 'EUR' });
    });

    it('builds the per-currency breakdown and total without a comparison period', async () => {
      prisma.expense.groupBy.mockResolvedValue([
        {
          categoryId: 'c1',
          currency: 'USD',
          date: new Date('2026-06-10'),
          _sum: { amount: 100, amountUsd: 100 },
          _count: { _all: 2 },
        },
        {
          categoryId: 'c1',
          currency: 'EUR',
          date: new Date('2026-06-10'),
          _sum: { amount: 50, amountUsd: 55 },
          _count: { _all: 1 },
        },
      ]);
      currency.historicalTotalInBase.mockReturnValue(140);

      const res = await service.statsByCategory('u1');

      expect(res).toEqual([
        {
          id: 'c1',
          name: 'Food',
          emoji: '🍔',
          count: 3,
          totals: [
            { currency: 'USD', total: 100, count: 2 },
            { currency: 'EUR', total: 50, count: 1 },
          ],
          baseCurrency: 'EUR',
          approxTotal: 140,
        },
      ]);
      // Only one groupBy call: no comparison period requested.
      expect(prisma.expense.groupBy).toHaveBeenCalledTimes(1);
      expect(currency.historicalTotalInBase).toHaveBeenCalledWith(
        expect.any(Array),
        'EUR',
        RATE_AT,
      );
    });

    it('computes the delta against the previous period when a compare range is given', async () => {
      prisma.expense.groupBy
        .mockResolvedValueOnce([
          {
            categoryId: 'c1',
            currency: 'USD',
            date: new Date('2026-06-10'),
            _sum: { amount: 100, amountUsd: 100 },
            _count: { _all: 1 },
          },
        ])
        .mockResolvedValueOnce([
          {
            categoryId: 'c1',
            currency: 'USD',
            date: new Date('2026-06-10'),
            _sum: { amount: 60, amountUsd: 60 },
            _count: { _all: 1 },
          },
        ]);
      currency.historicalTotalInBase.mockReturnValueOnce(100).mockReturnValueOnce(60);

      const res = await service.statsByCategory('u1', { compareFrom: new Date('2026-05-01') });

      expect(prisma.expense.groupBy).toHaveBeenCalledTimes(2);
      expect(res[0]).toMatchObject({
        approxTotal: 100,
        previousApproxTotal: 60,
        deltaApproxTotal: 40,
      });
    });

    it('returns a null delta when either total is unavailable', async () => {
      prisma.expense.groupBy.mockResolvedValue([]);
      currency.historicalTotalInBase.mockReturnValueOnce(null).mockReturnValueOnce(60);

      const res = await service.statsByCategory('u1', { compareTo: new Date('2026-05-31') });

      expect(res[0].deltaApproxTotal).toBeNull();
    });
  });
});
