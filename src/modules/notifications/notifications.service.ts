import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { NotificationDto, NotificationsResponseDto } from './dto/notification-response.dto';

interface CurrencyGroup {
  currency: string;
  amount: number;
  amountUsd: number | null;
}

// Proactive Telegram bot pushes the user can individually opt out of. Extend this list to add a
// new toggle — any type not in here (or without a stored row) is enabled by default.
export const BOT_NOTIFICATION_TYPES = ['monthly_digest', 'trade_closed'] as const;
export type BotNotificationType = (typeof BOT_NOTIFICATION_TYPES)[number];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Fetched on entry. Recomputes the current-month summary (so fresh income/expense changes show up)
   * and returns all notifications for the user, newest first, plus the unread count for the badge.
   */
  async list(userId: string): Promise<NotificationsResponseDto> {
    await this.generateMonthlySummary(userId);

    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const items: NotificationDto[] = rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      payload: n.payload ?? null,
      isRead: n.isRead,
      createdAt: n.createdAt,
    }));

    const unreadCount = items.reduce((acc, n) => acc + (n.isRead ? 0 : 1), 0);
    return { items, unreadCount };
  }

  /** Marks a single notification read. No-op (count unchanged) if it isn't the user's or already read. */
  async markRead(userId: string, id: string): Promise<{ unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { id, userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { unreadCount: await this.unreadCount(userId) };
  }

  /** "Mark all as read" — marks every unread notification of the user read. */
  async markAllRead(userId: string): Promise<{ unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { unreadCount: 0 };
  }

  private unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  /**
   * Computes the income / expense / net for the current calendar month (UTC) plus the top expense
   * category, then upserts a single "monthly_summary:YYYY-MM" notification. Re-running refreshes the
   * numbers without touching isRead, so a summary the user already read stays read.
   */
  private async generateMonthlySummary(userId: string): Promise<void> {
    const now = new Date();
    const summary = await this.computeMonthSummary(userId, now.getUTCFullYear(), now.getUTCMonth());
    if (!summary) return; // nothing happened this month yet — don't create an empty card

    const dedupeKey = `monthly_summary:${summary.period}`;
    await this.prisma.notification.upsert({
      where: { userId_dedupeKey: { userId, dedupeKey } },
      // Refresh content only — isRead/readAt are intentionally left as they are.
      // title/body are omitted: the frontend localizes from `payload`.
      update: { payload: summary as Prisma.InputJsonValue },
      create: {
        userId,
        type: 'monthly_summary',
        dedupeKey,
        payload: summary as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Income / expense / net / top-expense-category for one calendar month (UTC), in the user's base
   * currency. Shared by the current-month bell card above and the monthly digest cron (which also
   * needs the same shape for the prior month, for comparison). Returns null when the user had no
   * income or expense at all that month — callers should treat that as "nothing to show".
   */
  async computeMonthSummary(
    userId: string,
    year: number,
    month: number, // 0-based, UTC
  ): Promise<{
    period: string;
    baseCurrency: string;
    income: number | null;
    expense: number | null;
    net: number | null;
    topCategory: { name: string; emoji: string | null } | null;
  } | null> {
    const monthStart = new Date(Date.UTC(year, month, 1));
    const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));
    const period = `${year}-${String(month + 1).padStart(2, '0')}`;
    const dateRange = { gte: monthStart, lt: nextMonthStart };

    const [incomeGroups, expenseGroups, user, rates, topExpenseGroup] = await Promise.all([
      this.prisma.income.groupBy({
        by: ['currency'],
        where: { userId, date: dateRange },
        _sum: { amount: true, amountUsd: true },
      }),
      this.prisma.expense.groupBy({
        by: ['currency'],
        where: { userId, date: dateRange },
        _sum: { amount: true, amountUsd: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
      this.prisma.expense.groupBy({
        by: ['categoryId'],
        where: { userId, date: dateRange },
        _sum: { amountUsd: true },
        orderBy: { _sum: { amountUsd: 'desc' } },
        take: 1,
      }),
    ]);

    if (incomeGroups.length === 0 && expenseGroups.length === 0) return null;

    const toRows = (groups: typeof incomeGroups): CurrencyGroup[] =>
      groups.map((g) => ({
        currency: g.currency,
        amount: Number(g._sum.amount ?? 0),
        amountUsd: g._sum.amountUsd != null ? Number(g._sum.amountUsd) : null,
      }));

    const baseCurrency = user?.currency ?? 'USD';
    const income = this.currency.approxTotalInBase(toRows(incomeGroups), baseCurrency, rates);
    const expense = this.currency.approxTotalInBase(toRows(expenseGroups), baseCurrency, rates);
    const net =
      income !== null && expense !== null ? Math.round((income - expense) * 100) / 100 : null;

    let topCategory: { name: string; emoji: string | null } | null = null;
    const topCategoryId = topExpenseGroup[0]?.categoryId;
    if (topCategoryId) {
      const cat = await this.prisma.expenseCategory.findUnique({
        where: { id: topCategoryId },
        select: { name: true, emoji: true },
      });
      if (cat) topCategory = { name: cat.name, emoji: cat.emoji };
    }

    return { period, baseCurrency, income, expense, net, topCategory };
  }

  /** Whether `type` should still be pushed to the user's Telegram chat. No stored row = enabled. */
  async isBotPushEnabled(userId: string, type: BotNotificationType): Promise<boolean> {
    const pref = await this.prisma.botNotificationPreference.findUnique({
      where: { userId_type: { userId, type } },
    });
    return pref?.enabled ?? true;
  }

  /** All known bot notification types for this user, merged with any stored overrides. */
  async listBotNotificationPreferences(
    userId: string,
  ): Promise<{ type: BotNotificationType; enabled: boolean }[]> {
    const rows = await this.prisma.botNotificationPreference.findMany({ where: { userId } });
    const byType = new Map(rows.map((r) => [r.type, r.enabled]));
    return BOT_NOTIFICATION_TYPES.map((type) => ({ type, enabled: byType.get(type) ?? true }));
  }

  async setBotNotificationPreference(
    userId: string,
    type: BotNotificationType,
    enabled: boolean,
  ): Promise<void> {
    await this.prisma.botNotificationPreference.upsert({
      where: { userId_type: { userId, type } },
      update: { enabled },
      create: { userId, type, enabled },
    });
  }
}
