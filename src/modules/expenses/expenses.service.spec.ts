import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { CreateExpenseDto } from './dto/create-expense.dto';
import { ExpensesService } from './expenses.service';

// A minimal CreateExpenseDto with overridable fields (validation runs at the HTTP layer, not here).
const makeDto = (over: Partial<CreateExpenseDto> = {}): CreateExpenseDto => ({
  categoryId: 'cat-1',
  amount: 1500,
  description: 'Groceries',
  date: new Date('2026-06-01T00:00:00Z'),
  ...over,
});

describe('ExpensesService', () => {
  let service: ExpensesService;
  let prisma: {
    expense: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let currency: { convert: jest.Mock; getRates: jest.Mock; historicalTotalInBase: jest.Mock };
  let fx: { convertOn: jest.Mock; resolverFor: jest.Mock };

  beforeEach(async () => {
    prisma = {
      expense: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    currency = { convert: jest.fn(), getRates: jest.fn(), historicalTotalInBase: jest.fn() };
    fx = { convertOn: jest.fn(), resolverFor: jest.fn().mockResolvedValue(() => 1) };

    const module = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
        { provide: FxRatesService, useValue: fx },
        { provide: SubscriptionsService, useValue: { assertCanAddTransaction: jest.fn() } },
      ],
    }).compile();

    service = module.get(ExpensesService);
  });

  describe('create', () => {
    it('uses the provided currency and snapshots amountUsd at the current rate', async () => {
      fx.convertOn.mockResolvedValue(42);
      prisma.expense.create.mockResolvedValue({ id: 'e1' });
      const dto = makeDto({ currency: 'THB' });

      const result = await service.create('u1', dto);

      expect(fx.convertOn).toHaveBeenCalledWith(1500, 'THB', 'USD', expect.any(Date));
      expect(prisma.expense.create).toHaveBeenCalledWith({
        data: { ...dto, userId: 'u1', currency: 'THB', amountUsd: 42 },
      });
      // No need to look up the user when the currency is explicit.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'e1' });
    });

    it("falls back to the user's currency when none is given", async () => {
      prisma.user.findUnique.mockResolvedValue({ currency: 'EUR' });
      fx.convertOn.mockResolvedValue(10);
      prisma.expense.create.mockResolvedValue({});
      const dto = makeDto({ amount: 9 });

      await service.create('u1', dto);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { currency: true },
      });
      expect(fx.convertOn).toHaveBeenCalledWith(9, 'EUR', 'USD', expect.any(Date));
      expect(prisma.expense.create).toHaveBeenCalledWith({
        data: { ...dto, userId: 'u1', currency: 'EUR', amountUsd: 10 },
      });
    });

    it('defaults to USD when the user has no currency set', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      fx.convertOn.mockResolvedValue(5);
      prisma.expense.create.mockResolvedValue({});

      await service.create('u1', makeDto({ amount: 5 }));

      expect(fx.convertOn).toHaveBeenCalledWith(5, 'USD', 'USD', expect.any(Date));
    });
  });

  describe('findOne', () => {
    it('returns the expense when it belongs to the user', async () => {
      prisma.expense.findFirst.mockResolvedValue({ id: 'e1' });
      await expect(service.findOne('e1', 'u1')).resolves.toEqual({ id: 'e1' });
      expect(prisma.expense.findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', userId: 'u1' },
        include: { category: true },
      });
    });

    it('throws NotFoundException when it is missing or owned by someone else', async () => {
      prisma.expense.findFirst.mockResolvedValue(null);
      await expect(service.findOne('e1', 'u1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('recomputes the amountUsd snapshot when the amount changes', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      fx.convertOn.mockResolvedValue(200);
      prisma.expense.update.mockResolvedValue({});

      await service.update('e1', 'u1', { amount: 200 });

      expect(fx.convertOn).toHaveBeenCalledWith(200, 'USD', 'USD', expect.any(Date));
      expect(prisma.expense.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { amount: 200, amountUsd: 200 },
      });
    });

    it('leaves amountUsd untouched when neither amount nor currency changes', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      prisma.expense.update.mockResolvedValue({});

      await service.update('e1', 'u1', { description: 'updated' });

      expect(fx.convertOn).not.toHaveBeenCalled();
      expect(prisma.expense.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { description: 'updated' },
      });
    });

    it('skips the snapshot when amount and currency are sent but unchanged', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      prisma.expense.update.mockResolvedValue({});

      await service.update('e1', 'u1', { amount: 100, currency: 'USD', description: 'updated' });

      expect(fx.convertOn).not.toHaveBeenCalled();
      expect(prisma.expense.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { amount: 100, currency: 'USD', description: 'updated' },
      });
    });

    it('recomputes the snapshot when only the currency changes', async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: 'e1',
        amount: 100,
        currency: 'USD',
        date: new Date('2026-06-01T00:00:00Z'),
      });
      fx.convertOn.mockResolvedValue(3.1);
      prisma.expense.update.mockResolvedValue({});

      await service.update('e1', 'u1', { amount: 100, currency: 'THB' });

      expect(fx.convertOn).toHaveBeenCalledWith(100, 'THB', 'USD', expect.any(Date));
      expect(prisma.expense.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { amount: 100, currency: 'THB', amountUsd: 3.1 },
      });
    });

    it('throws when updating an expense that does not belong to the user', async () => {
      prisma.expense.findFirst.mockResolvedValue(null);
      await expect(service.update('e1', 'u1', { amount: 1 })).rejects.toThrow(NotFoundException);
      expect(prisma.expense.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes after verifying ownership', async () => {
      prisma.expense.findFirst.mockResolvedValue({ id: 'e1' });
      prisma.expense.delete.mockResolvedValue({ id: 'e1' });

      await service.remove('e1', 'u1');

      expect(prisma.expense.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });

    it('throws and deletes nothing when the expense is not owned', async () => {
      prisma.expense.findFirst.mockResolvedValue(null);
      await expect(service.remove('e1', 'u1')).rejects.toThrow(NotFoundException);
      expect(prisma.expense.delete).not.toHaveBeenCalled();
    });
  });

  describe('removeMany', () => {
    // The transaction callback runs against a `tx` client; the mock just invokes it inline.
    const runTx = (tx: unknown) =>
      prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(tx));

    it('deletes every id when they all belong to the user', async () => {
      const tx = {
        expense: {
          findMany: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };
      runTx(tx);

      await expect(service.removeMany('u1', ['a', 'b'])).resolves.toEqual({ deleted: 2 });
      expect(tx.expense.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, userId: 'u1' },
      });
    });

    it('throws and deletes nothing when some ids are not owned', async () => {
      const tx = {
        expense: {
          findMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
          deleteMany: jest.fn(),
        },
      };
      runTx(tx);

      await expect(service.removeMany('u1', ['a', 'b'])).rejects.toThrow(NotFoundException);
      expect(tx.expense.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('statDetails', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      amount: 100,
      amountUsd: 1,
      currency: 'THB',
      description: 'x',
      date: new Date('2026-06-15T00:00:00Z'),
      category: { name: 'Food', emoji: '🍔' },
      ...over,
    });

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ currency: 'RUB', timezone: 'UTC' });
      currency.getRates.mockResolvedValue({});
      // Total = plain sum of the group amounts — enough to verify wiring.
      currency.historicalTotalInBase.mockImplementation(
        (groups: { amount: number }[]) => groups.reduce((s, g) => s + g.amount, 0) || null,
      );
    });

    it('groups operations by category with per-category and overall totals', async () => {
      prisma.expense.findMany.mockResolvedValue([
        row({ amount: 100 }),
        row({ amount: 50, description: 'y' }),
        row({ amount: 7, currency: 'USD', category: { name: 'Taxi', emoji: '🚕' } }),
      ]);

      const result = await service.statDetails('u1', null, 'month');

      expect(result.baseCurrency).toBe('RUB');
      expect(result.total).toBe(157);
      expect(result.categories).toHaveLength(2);
      const [food, taxi] = result.categories;
      expect(food).toMatchObject({ category: 'Food', emoji: '🍔', total: 150 });
      expect(food.items).toHaveLength(2);
      // Items keep the operation's original currency.
      expect(taxi.items).toEqual([
        expect.objectContaining({ amount: 7, currency: 'USD', description: 'x' }),
      ]);
    });

    it('filters by an explicit date range, ignoring period', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-01-31T23:59:59.999Z');

      await service.statDetails('u1', null, 'day', { from, to });

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', date: { gte: from, lte: to } } }),
      );
    });

    it('supports an open-ended range (only from)', async () => {
      prisma.expense.findMany.mockResolvedValue([]);
      const from = new Date('2026-01-01T00:00:00Z');

      await service.statDetails('u1', null, 'month', { from });

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', date: { gte: from, lte: undefined } },
        }),
      );
    });

    it('falls back to the period bounds when no range is given, narrowed by categoryId', async () => {
      prisma.expense.findMany.mockResolvedValue([]);

      await service.statDetails('u1', 'cat-1', 'month');

      const { where } = prisma.expense.findMany.mock.calls[0][0];
      expect(where.categoryId).toBe('cat-1');
      expect(where.date.gte).toBeInstanceOf(Date);
      expect(where.date.lte).toBeInstanceOf(Date);
      // The month period starts on the 1st at 00:00 (wall clock).
      expect(where.date.gte.getUTCDate()).toBe(1);
      expect(where.date.gte.getTime()).toBeLessThanOrEqual(where.date.lte.getTime());
    });
  });
});
