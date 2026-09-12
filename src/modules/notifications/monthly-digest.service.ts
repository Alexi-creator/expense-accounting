import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { BotService } from '../../bot/bot.service';
import { withEmoji } from '../../bot/handlers/category.util';
import { resolveLocale, t } from '../../bot/i18n';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { NotificationsService } from './notifications.service';

const formatSigned = (value: number, digits = 2) =>
  `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

// null when there's nothing meaningful to compare against (no baseline, or baseline was zero —
// an "infinite" jump from zero reads as noise, not signal).
const formatPercentChange = (current: number, baseline: number | null): string | null => {
  if (baseline === null || baseline === 0) return null;
  return `${formatSigned(((current - baseline) / Math.abs(baseline)) * 100, 1)}%`;
};

// { year, month } normalized the way Date.UTC does it — month can be handed in out of the 0-11
// range (e.g. -1) and rolls into the adjacent year, which plain arithmetic on the two fields would not.
function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/**
 * On the 1st of each month, recaps the previous calendar month vs the one before it and pushes it
 * to the user's Telegram chat (also left as a richer 'monthly_digest' bell card). Distinct from
 * the lightweight 'monthly_summary' NotificationsService.list() computes lazily for the *current*,
 * still-running month — this one is for a month that's actually over.
 */
@Injectable()
export class MonthlyDigestService {
  private readonly logger = new Logger(MonthlyDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly currency: CurrencyService,
    private readonly fx: FxRatesService,
    private readonly subscriptions: SubscriptionsService,
    private readonly bot: BotService,
  ) {}

  @Cron('0 9 1 * *')
  async sendAll(): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { telegramId: { not: null } },
      select: { id: true },
    });
    for (const { id: userId } of users) {
      await this.sendOne(userId).catch((err) => {
        this.logger.warn(`Failed to send monthly digest to user ${userId}: ${err}`);
      });
    }
  }

  private async sendOne(userId: string): Promise<void> {
    const now = new Date();
    const target = shiftMonth(now.getUTCFullYear(), now.getUTCMonth(), -1);
    const baselineYm = shiftMonth(now.getUTCFullYear(), now.getUTCMonth(), -2);

    const [summary, baseline] = await Promise.all([
      this.notifications.computeMonthSummary(userId, target.year, target.month),
      this.notifications.computeMonthSummary(userId, baselineYm.year, baselineYm.month),
    ]);
    if (!summary) return; // nothing happened last month — don't send an empty digest

    const [biggestExpense, goalsData, investingPnl, user] = await Promise.all([
      this.findBiggestExpense(userId, target.year, target.month),
      this.summarizeGoals(userId, target.year, target.month, summary.baseCurrency),
      this.summarizeInvesting(userId, target.year, target.month),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { telegramId: true, languageCode: true },
      }),
    ]);

    const payload = {
      ...summary,
      baselineIncome: baseline?.income ?? null,
      baselineExpense: baseline?.expense ?? null,
      biggestExpense,
      goalsContributed: goalsData.contributed,
      goalsCompleted: goalsData.completedCount,
      investingPnl,
    } satisfies Record<string, unknown> as Prisma.InputJsonValue;

    const dedupeKey = `monthly_digest:${summary.period}`;
    try {
      await this.prisma.notification.create({
        data: { userId, type: 'monthly_digest', dedupeKey, payload },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // already sent for this period
      throw err;
    }

    if (!user?.telegramId) return;
    if (!(await this.notifications.isBotPushEnabled(userId, 'monthly_digest'))) return;

    const locale = resolveLocale(user.languageCode);
    const m = t(locale);
    const fmt = (v: number) => `${v.toFixed(2)} ${summary.baseCurrency}`;

    const periodLabel = new Date(Date.UTC(target.year, target.month, 1)).toLocaleDateString(
      m.dateLocale,
      { month: 'long', year: 'numeric' },
    );
    const lines: string[] = [m.digestHeading(periodLabel), ''];

    if (summary.income !== null) {
      const change = formatPercentChange(summary.income, baseline?.income ?? null);
      lines.push(
        `${m.digestIncome}: ${fmt(summary.income)}` +
          (change ? ` (${change} ${m.digestVsPrevMonth})` : ''),
      );
    }
    if (summary.expense !== null) {
      const change = formatPercentChange(summary.expense, baseline?.expense ?? null);
      lines.push(
        `${m.digestExpense}: ${fmt(summary.expense)}` +
          (change ? ` (${change} ${m.digestVsPrevMonth})` : ''),
      );
    }
    if (summary.net !== null) lines.push(`${m.digestNet}: ${fmt(summary.net)}`);
    if (summary.income && summary.income > 0 && summary.net !== null) {
      lines.push(`${m.digestSavingsRate}: ${((summary.net / summary.income) * 100).toFixed(1)}%`);
    }
    if (summary.topCategory) {
      lines.push(
        `${m.digestTopCategory}: ${withEmoji(summary.topCategory.name, summary.topCategory.emoji)}`,
      );
    }
    if (biggestExpense) {
      lines.push(
        `${m.digestBiggestExpense}: ${withEmoji(biggestExpense.category, biggestExpense.emoji)} — ${fmt(biggestExpense.amount)}`,
      );
    }
    if (goalsData.contributed !== null && goalsData.contributed > 0) {
      lines.push(`${m.digestGoalsContributed}: ${fmt(goalsData.contributed)}`);
    }
    if (goalsData.completedCount > 0) {
      lines.push(`${m.digestGoalsCompleted}: ${goalsData.completedCount}`);
    }
    if (investingPnl !== null) {
      lines.push(`${m.digestInvestingPnl}: ${formatSigned(investingPnl)} USDT`);
    }

    await this.bot.pushMessage(user.telegramId, lines.join('\n'));
  }

  private async findBiggestExpense(
    userId: string,
    year: number,
    month: number,
  ): Promise<{ category: string; emoji: string | null; amount: number } | null> {
    const dateRange = {
      gte: new Date(Date.UTC(year, month, 1)),
      lt: new Date(Date.UTC(year, month + 1, 1)),
    };
    const expense = await this.prisma.expense.findFirst({
      where: { userId, date: dateRange, amountUsd: { not: null } },
      orderBy: { amountUsd: 'desc' },
      include: { category: true },
    });
    if (!expense?.amountUsd) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true },
    });
    // Converted at the rate of the expense's own date: the digest recaps a month that is over, so
    // its figures should read the same whenever the card is opened again.
    const inBase = await this.fx.convertOn(
      Number(expense.amountUsd),
      'USD',
      user?.currency ?? 'USD',
      expense.date,
    );
    if (inBase === null) return null;
    const amount = Math.round(inBase * 100) / 100;

    return { category: expense.category.name, emoji: expense.category.emoji, amount };
  }

  private async summarizeGoals(
    userId: string,
    year: number,
    month: number,
    baseCurrency: string,
  ): Promise<{ contributed: number | null; completedCount: number }> {
    const dateRange = {
      gte: new Date(Date.UTC(year, month, 1)),
      lt: new Date(Date.UTC(year, month + 1, 1)),
    };
    const [contributions, completedCount] = await Promise.all([
      this.prisma.goalContribution.findMany({
        where: { userId, date: dateRange },
        select: { amount: true, date: true, goal: { select: { currency: true } } },
      }),
      this.prisma.goal.count({ where: { userId, completedAt: dateRange } }),
    ]);

    if (contributions.length === 0) return { contributed: 0, completedCount };

    const rows = contributions.map((c) => ({
      amount: Number(c.amount),
      currency: c.goal.currency,
      amountUsd: null,
      date: c.date,
    }));
    // A contribution counts for what it was worth when it was made, same as every other figure
    // in a digest for a month that has already closed.
    const rateAt = await this.fx.resolverFor(
      [baseCurrency, ...rows.map((r) => r.currency)],
      dateRange.gte,
      dateRange.lt,
    );
    const contributed = this.currency.historicalTotalInBase(rows, baseCurrency, rateAt);

    return { contributed, completedCount };
  }

  private async summarizeInvesting(
    userId: string,
    year: number,
    month: number,
  ): Promise<number | null> {
    if (!(await this.subscriptions.hasInvestingAccess(userId))) return null;

    const dateRange = {
      gte: new Date(Date.UTC(year, month, 1)),
      lt: new Date(Date.UTC(year, month + 1, 1)),
    };
    const agg = await this.prisma.position.aggregate({
      where: { userId, source: 'bybit', closedAt: dateRange },
      _sum: { closedPnl: true },
    });
    return agg._sum.closedPnl ? Number(agg._sum.closedPnl) : null;
  }
}
