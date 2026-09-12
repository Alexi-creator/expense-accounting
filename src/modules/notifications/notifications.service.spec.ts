import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    income: { groupBy: jest.Mock };
    expense: { groupBy: jest.Mock };
    user: { findUnique: jest.Mock };
    expenseCategory: { findUnique: jest.Mock };
    notification: {
      findMany: jest.Mock;
      upsert: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    botNotificationPreference: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let currency: { getRates: jest.Mock; historicalTotalInBase: jest.Mock };
  let fx: { resolverFor: jest.Mock };

  beforeEach(async () => {
    prisma = {
      income: { groupBy: jest.fn().mockResolvedValue([]) },
      expense: { groupBy: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue({ currency: 'USD' }) },
      expenseCategory: { findUnique: jest.fn() },
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      botNotificationPreference: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    currency = { getRates: jest.fn().mockResolvedValue({}), historicalTotalInBase: jest.fn() };
    fx = { resolverFor: jest.fn().mockResolvedValue(() => 1) };

    const module = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
        { provide: FxRatesService, useValue: fx },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  afterEach(() => jest.useRealTimers());

  describe('list', () => {
    it('does not create a summary when there was no activity this month', async () => {
      const res = await service.list('u1');

      expect(prisma.notification.upsert).not.toHaveBeenCalled();
      expect(res).toEqual({ items: [], unreadCount: 0 });
    });

    it('upserts the monthly summary keyed by period without touching isRead', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-21T00:00:00Z'));
      prisma.income.groupBy.mockResolvedValue([
        {
          currency: 'USD',
          date: new Date('2026-06-10T00:00:00Z'),
          _sum: { amount: 100, amountUsd: 100 },
        },
      ]);
      prisma.expense.groupBy
        .mockResolvedValueOnce([
          {
            currency: 'USD',
            date: new Date('2026-06-10T00:00:00Z'),
            _sum: { amount: 40, amountUsd: 40 },
          },
        ]) // by currency and date
        .mockResolvedValueOnce([{ categoryId: 'c1', _sum: { amountUsd: 40 } }]); // top category
      prisma.expenseCategory.findUnique.mockResolvedValue({ name: 'Рестораны', emoji: '🍽️' });
      currency.historicalTotalInBase.mockReturnValueOnce(100).mockReturnValueOnce(40); // income, expense
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'n1',
          type: 'monthly_summary',
          title: 't',
          body: 'b',
          payload: {},
          isRead: false,
          createdAt: new Date(),
        },
      ]);

      const res = await service.list('u1');

      const arg = prisma.notification.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        userId_dedupeKey: { userId: 'u1', dedupeKey: 'monthly_summary:2026-06' },
      });
      expect(arg.create).toMatchObject({ type: 'monthly_summary' });
      // re-generation must not reset the read state
      expect(arg.update).not.toHaveProperty('isRead');
      expect(res.unreadCount).toBe(1);
    });
  });

  describe('read state', () => {
    it('markRead flips one unread notification and returns the new count', async () => {
      prisma.notification.count.mockResolvedValue(2);

      const res = await service.markRead('u1', 'n1');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'u1', isRead: false },
        data: expect.objectContaining({ isRead: true }),
      });
      expect(res).toEqual({ unreadCount: 2 });
    });

    it('markAllRead clears every unread notification', async () => {
      const res = await service.markAllRead('u1');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isRead: false },
        data: expect.objectContaining({ isRead: true }),
      });
      expect(res).toEqual({ unreadCount: 0 });
    });
  });

  describe('bot notification preferences', () => {
    it('defaults to enabled when no row is stored', async () => {
      await expect(service.isBotPushEnabled('u1', 'trade_closed')).resolves.toBe(true);
    });

    it('respects a stored opt-out', async () => {
      prisma.botNotificationPreference.findUnique.mockResolvedValue({ enabled: false });
      await expect(service.isBotPushEnabled('u1', 'trade_closed')).resolves.toBe(false);
    });

    it('lists every known type, merging stored overrides with the enabled-by-default fallback', async () => {
      prisma.botNotificationPreference.findMany.mockResolvedValue([
        { type: 'trade_closed', enabled: false },
      ]);

      const prefs = await service.listBotNotificationPreferences('u1');

      expect(prefs).toEqual([
        { type: 'monthly_digest', enabled: true },
        { type: 'trade_closed', enabled: false },
      ]);
    });

    it('upserts the toggle by (userId, type)', async () => {
      await service.setBotNotificationPreference('u1', 'monthly_digest', false);

      expect(prisma.botNotificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId_type: { userId: 'u1', type: 'monthly_digest' } },
        update: { enabled: false },
        create: { userId: 'u1', type: 'monthly_digest', enabled: false },
      });
    });
  });
});
