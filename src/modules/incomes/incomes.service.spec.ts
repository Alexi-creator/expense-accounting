import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { CreateIncomeDto } from './dto/create-income.dto';
import { IncomesService } from './incomes.service';

const makeDto = (over: Partial<CreateIncomeDto> = {}): CreateIncomeDto => ({
  categoryId: 'cat-1',
  amount: 50000,
  description: 'Salary',
  date: new Date('2026-06-01T00:00:00Z'),
  ...over,
});

describe('IncomesService', () => {
  let service: IncomesService;
  let prisma: {
    income: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let currency: { convert: jest.Mock; getRates: jest.Mock; approxTotalInBase: jest.Mock };
  let fx: { convertOn: jest.Mock };

  beforeEach(async () => {
    prisma = {
      income: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    currency = { convert: jest.fn(), getRates: jest.fn(), approxTotalInBase: jest.fn() };
    fx = { convertOn: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        IncomesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
        { provide: FxRatesService, useValue: fx },
        { provide: SubscriptionsService, useValue: { assertCanAddTransaction: jest.fn() } },
      ],
    }).compile();

    service = module.get(IncomesService);
  });

  describe('create', () => {
    it('uses the provided currency and snapshots amountUsd', async () => {
      fx.convertOn.mockResolvedValue(1400);
      prisma.income.create.mockResolvedValue({ id: 'i1' });
      const dto = makeDto({ currency: 'THB' });

      const result = await service.create('u1', dto);

      expect(fx.convertOn).toHaveBeenCalledWith(50000, 'THB', 'USD', expect.any(Date));
      expect(prisma.income.create).toHaveBeenCalledWith({
        data: { ...dto, userId: 'u1', currency: 'THB', amountUsd: 1400 },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'i1' });
    });

    it("falls back to the user's currency, then to USD", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ currency: 'EUR' });
      fx.convertOn.mockResolvedValue(1);
      prisma.income.create.mockResolvedValue({});
      await service.create('u1', makeDto({ amount: 1 }));
      expect(fx.convertOn).toHaveBeenCalledWith(1, 'EUR', 'USD', expect.any(Date));

      prisma.user.findUnique.mockResolvedValueOnce(null);
      await service.create('u1', makeDto({ amount: 2 }));
      expect(fx.convertOn).toHaveBeenCalledWith(2, 'USD', 'USD', expect.any(Date));
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when missing or not owned', async () => {
      prisma.income.findFirst.mockResolvedValue(null);
      await expect(service.findOne('i1', 'u1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('recomputes amountUsd when the currency changes', async () => {
      prisma.income.findFirst.mockResolvedValue({
        id: 'i1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      fx.convertOn.mockResolvedValue(95);
      prisma.income.update.mockResolvedValue({});

      await service.update('i1', 'u1', { currency: 'EUR' });

      // amount falls back to the existing value, currency to the new one.
      expect(fx.convertOn).toHaveBeenCalledWith(100, 'EUR', 'USD', expect.any(Date));
      expect(prisma.income.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { currency: 'EUR', amountUsd: 95 },
      });
    });

    it('leaves amountUsd untouched when amount/currency are unchanged', async () => {
      prisma.income.findFirst.mockResolvedValue({
        id: 'i1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      prisma.income.update.mockResolvedValue({});

      await service.update('i1', 'u1', { description: 'fixed' });

      expect(fx.convertOn).not.toHaveBeenCalled();
      expect(prisma.income.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { description: 'fixed' },
      });
    });

    it('skips the snapshot when amount and currency are sent but unchanged', async () => {
      prisma.income.findFirst.mockResolvedValue({
        id: 'i1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      prisma.income.update.mockResolvedValue({});

      await service.update('i1', 'u1', { amount: 100, currency: 'USD', description: 'fixed' });

      expect(fx.convertOn).not.toHaveBeenCalled();
      expect(prisma.income.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { amount: 100, currency: 'USD', description: 'fixed' },
      });
    });
  });

  describe('remove', () => {
    it('throws and deletes nothing when not owned', async () => {
      prisma.income.findFirst.mockResolvedValue(null);
      await expect(service.remove('i1', 'u1')).rejects.toThrow(NotFoundException);
      expect(prisma.income.delete).not.toHaveBeenCalled();
    });
  });

  describe('removeMany', () => {
    const runTx = (tx: unknown) =>
      prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(tx));

    it('deletes every id when all belong to the user', async () => {
      const tx = {
        income: {
          findMany: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };
      runTx(tx);
      await expect(service.removeMany('u1', ['a', 'b'])).resolves.toEqual({ deleted: 2 });
    });

    it('throws and deletes nothing when some ids are not owned', async () => {
      const tx = {
        income: {
          findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
          deleteMany: jest.fn(),
        },
      };
      runTx(tx);
      await expect(service.removeMany('u1', ['a', 'b'])).rejects.toThrow(NotFoundException);
      expect(tx.income.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('statDetails', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ currency: 'RUB', timezone: 'UTC' });
      currency.getRates.mockResolvedValue({});
      // Total = plain sum of the group amounts — enough to verify wiring.
      currency.approxTotalInBase.mockImplementation(
        (groups: { amount: number }[]) => groups.reduce((s, g) => s + g.amount, 0) || null,
      );
    });

    it('groups operations by category with per-category and overall totals', async () => {
      const row = {
        amount: 50000,
        amountUsd: 600,
        currency: 'THB',
        description: 'Salary',
        date: new Date('2026-06-15T00:00:00Z'),
        category: { name: 'Work', emoji: '💼' },
      };
      prisma.income.findMany.mockResolvedValue([
        row,
        { ...row, amount: 100, currency: 'USD', category: { name: 'Gifts', emoji: '🎁' } },
      ]);

      const result = await service.statDetails('u1', null, 'month');

      expect(result.baseCurrency).toBe('RUB');
      expect(result.total).toBe(50100);
      expect(result.categories).toHaveLength(2);
      expect(result.categories[0]).toMatchObject({ category: 'Work', emoji: '💼', total: 50000 });
      // Items keep the operation's original currency.
      expect(result.categories[1].items).toEqual([
        expect.objectContaining({ amount: 100, currency: 'USD' }),
      ]);
    });

    it('filters by an explicit date range, ignoring period', async () => {
      prisma.income.findMany.mockResolvedValue([]);
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-01-31T23:59:59.999Z');

      await service.statDetails('u1', 'cat-1', 'day', { from, to });

      expect(prisma.income.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', categoryId: 'cat-1', date: { gte: from, lte: to } },
        }),
      );
    });
  });
});
