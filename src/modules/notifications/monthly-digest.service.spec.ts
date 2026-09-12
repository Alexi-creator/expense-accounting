import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { BotService } from '../../bot/bot.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { MonthlyDigestService } from './monthly-digest.service';
import { NotificationsService } from './notifications.service';

const P2002 = new Prisma.PrismaClientKnownRequestError('duplicate', {
  code: 'P2002',
  clientVersion: '0',
});

describe('MonthlyDigestService', () => {
  let service: MonthlyDigestService;
  let prisma: {
    user: { findMany: jest.Mock; findUnique: jest.Mock };
    expense: { findFirst: jest.Mock };
    goalContribution: { findMany: jest.Mock };
    goal: { count: jest.Mock };
    position: { aggregate: jest.Mock };
    notification: { create: jest.Mock };
  };
  let notifications: { computeMonthSummary: jest.Mock; isBotPushEnabled: jest.Mock };
  let currency: { getRates: jest.Mock; historicalTotalInBase: jest.Mock };
  let fx: { resolverFor: jest.Mock; convertOn: jest.Mock };
  let subscriptions: { hasInvestingAccess: jest.Mock };
  let bot: { pushMessage: jest.Mock };

  const summary = {
    period: '2026-06',
    baseCurrency: 'USD',
    income: 1000,
    expense: 400,
    net: 600,
    topCategory: { name: 'Food', emoji: '🍔' },
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'u1' }]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ telegramId: 42n, languageCode: 'en', currency: 'USD' }),
      },
      expense: { findFirst: jest.fn().mockResolvedValue(null) },
      goalContribution: { findMany: jest.fn().mockResolvedValue([]) },
      goal: { count: jest.fn().mockResolvedValue(0) },
      position: { aggregate: jest.fn().mockResolvedValue({ _sum: { closedPnl: null } }) },
      notification: { create: jest.fn().mockResolvedValue({}) },
    };
    notifications = {
      computeMonthSummary: jest.fn().mockResolvedValue(summary),
      isBotPushEnabled: jest.fn().mockResolvedValue(true),
    };
    currency = {
      getRates: jest.fn().mockResolvedValue({}),
      historicalTotalInBase: jest.fn().mockReturnValue(0),
    };
    fx = {
      resolverFor: jest.fn().mockResolvedValue(() => 1),
      convertOn: jest.fn().mockResolvedValue(0),
    };
    subscriptions = { hasInvestingAccess: jest.fn().mockResolvedValue(false) };
    bot = { pushMessage: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        MonthlyDigestService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: CurrencyService, useValue: currency },
        { provide: FxRatesService, useValue: fx },
        { provide: SubscriptionsService, useValue: subscriptions },
        { provide: BotService, useValue: bot },
      ],
    }).compile();

    service = module.get(MonthlyDigestService);
  });

  afterEach(() => jest.useRealTimers());

  it('rolls the target/baseline months across a year boundary (running in January)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T09:00:00Z'));
    notifications.computeMonthSummary.mockResolvedValueOnce(summary).mockResolvedValueOnce(null);

    await service.sendAll();

    // Run in January → target = December 2025 (index 11), baseline = November 2025 (index 10).
    expect(notifications.computeMonthSummary).toHaveBeenNthCalledWith(1, 'u1', 2025, 11);
    expect(notifications.computeMonthSummary).toHaveBeenNthCalledWith(2, 'u1', 2025, 10);
  });

  it('skips a user with no activity last month — no bell entry, no push', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T09:00:00Z'));
    notifications.computeMonthSummary.mockResolvedValue(null);

    await service.sendAll();

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(bot.pushMessage).not.toHaveBeenCalled();
  });

  it('sends the push with income/expense/net and skips already-sent periods (P2002)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T09:00:00Z'));

    await service.sendAll();
    expect(bot.pushMessage).toHaveBeenCalledTimes(1);
    const [telegramId, text] = bot.pushMessage.mock.calls[0];
    expect(telegramId).toBe(42n);
    expect(text).toContain('1000.00 USD');
    expect(text).toContain('400.00 USD');
    expect(text).toContain('600.00 USD');

    prisma.notification.create.mockRejectedValueOnce(P2002);
    bot.pushMessage.mockClear();
    await service.sendAll();
    expect(bot.pushMessage).not.toHaveBeenCalled();
  });

  it('does not push when the user disabled monthly_digest (bell entry still created)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T09:00:00Z'));
    notifications.isBotPushEnabled.mockResolvedValue(false);

    await service.sendAll();

    expect(prisma.notification.create).toHaveBeenCalled();
    expect(bot.pushMessage).not.toHaveBeenCalled();
  });

  it('one user failing does not stop the batch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T09:00:00Z'));
    prisma.user.findMany.mockResolvedValue([{ id: 'bad' }, { id: 'u1' }]);
    notifications.computeMonthSummary.mockImplementation((userId: string) =>
      userId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(summary),
    );

    await service.sendAll();

    expect(bot.pushMessage).toHaveBeenCalledTimes(1);
  });
});
