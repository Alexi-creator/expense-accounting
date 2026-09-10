import { Injectable, NotFoundException } from '@nestjs/common';
import { localWallClockNow } from '../../common/timezone.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { aggregateSummary, buildBuckets, type Granularity } from '../currency/summary.util';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@Injectable()
export class IncomesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
    private readonly fx: FxRatesService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async create(userId: string, dto: CreateIncomeDto) {
    await this.subscriptions.assertCanAddTransaction(userId);
    const currency = dto.currency ?? (await this.resolveUserCurrency(userId));
    // USD value snapshot at the rate of the operation's own date, not of the day it was entered:
    // a backdated row must be worth what it was worth then, and re-entering it must not move it.
    const amountUsd = await this.fx.convertOn(dto.amount, currency, 'USD', dto.date);
    return this.prisma.income.create({ data: { ...dto, userId, currency, amountUsd } });
  }

  private async resolveUserCurrency(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true },
    });
    return user?.currency ?? 'USD';
  }

  findAllByUser(userId: string, from?: Date, to?: Date) {
    return this.prisma.income.findMany({
      where: {
        userId,
        ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
      },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSummary(userId: string, range: { from: Date; to: Date; granularity: Granularity }) {
    const { from, to, granularity } = range;

    const [rows, user, rates] = await Promise.all([
      this.prisma.income.findMany({
        where: { userId, date: { gte: from, lte: to } },
        select: { amount: true, amountUsd: true, currency: true, date: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
    ]);

    const baseCurrency = user?.currency ?? 'USD';
    const bucketKeys = buildBuckets(from, to, granularity);
    return aggregateSummary(rows, bucketKeys, granularity, baseCurrency, rates, this.currency);
  }

  async findOne(id: string, userId: string) {
    const income = await this.prisma.income.findFirst({
      where: { id, userId },
      include: { category: true },
    });
    if (!income) throw new NotFoundException(`Income ${id} not found`);
    return income;
  }

  async update(id: string, userId: string, dto: UpdateIncomeDto) {
    const existing = await this.findOne(id, userId);

    // Recompute the USD snapshot only if the amount or currency actually changed (by value, not
    // payload presence: the frontend may send the whole form, and an untouched amount must not
    // silently re-snapshot at today's rate).
    const amountChanged = dto.amount !== undefined && dto.amount !== Number(existing.amount);
    const currencyChanged = dto.currency !== undefined && dto.currency !== existing.currency;
    // The date is part of the snapshot too — moving a row to another date changes the rate it is
    // valued at.
    const dateChanged =
      dto.date !== undefined && dto.date.getTime() !== new Date(existing.date).getTime();
    let amountUsd: number | null | undefined;
    if (amountChanged || currencyChanged || dateChanged) {
      const amount = dto.amount ?? Number(existing.amount);
      const currency = dto.currency ?? existing.currency;
      const date = dto.date ?? existing.date;
      amountUsd = await this.fx.convertOn(amount, currency, 'USD', date);
    }

    return this.prisma.income.update({
      where: { id },
      data: { ...dto, ...(amountUsd !== undefined ? { amountUsd } : {}) },
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.income.delete({ where: { id } });
  }

  // Bulk delete: first verify that all ids belong to the user,
  // otherwise 404 and delete nothing (atomically, in a transaction).
  async removeMany(userId: string, ids: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.income.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((e) => e.id));
      const missing = ids.filter((id) => !ownedIds.has(id));
      if (missing.length) {
        throw new NotFoundException(`Incomes not found: ${missing.join(', ')}`);
      }

      const { count } = await tx.income.deleteMany({ where: { id: { in: ids }, userId } });
      return { deleted: count };
    });
  }

  async statSummary(userId: string, categoryId: string | null, period: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, timezone: true },
    });
    const baseCurrency = user?.currency ?? 'USD';
    const { from, to } = this.getPeriodDates(period, user?.timezone ?? 'UTC');

    const [grouped, rates] = await Promise.all([
      this.prisma.income.groupBy({
        by: ['categoryId', 'currency'],
        where: { userId, ...(categoryId ? { categoryId } : {}), date: { gte: from, lte: to } },
        _sum: { amount: true, amountUsd: true },
      }),
      this.currency.getRates(),
    ]);

    // categoryId -> per-currency breakdown (for converting to the base currency)
    const groupsByCategory = new Map<
      string,
      { currency: string; amount: number; amountUsd: number | null }[]
    >();
    const allGroups: { currency: string; amount: number; amountUsd: number | null }[] = [];
    for (const g of grouped) {
      const row = {
        currency: g.currency,
        amount: Number(g._sum.amount ?? 0),
        amountUsd: g._sum.amountUsd != null ? Number(g._sum.amountUsd) : null,
      };
      const list = groupsByCategory.get(g.categoryId) ?? [];
      list.push(row);
      groupsByCategory.set(g.categoryId, list);
      allGroups.push(row);
    }

    const categories = await this.prisma.incomeCategory.findMany({
      where: { id: { in: [...groupsByCategory.keys()] } },
      select: { id: true, name: true, emoji: true },
    });
    const catMap = new Map(categories.map((c) => [c.id, c]));

    const items = [...groupsByCategory.entries()].map(([catId, groups]) => ({
      category: catMap.get(catId)?.name ?? '—',
      emoji: catMap.get(catId)?.emoji ?? null,
      // Category total in the base currency (approx. by rate). null if rates are unavailable.
      total: this.currency.approxTotalInBase(groups, baseCurrency, rates),
    }));

    return {
      baseCurrency,
      // Overall total — a single conversion across all rows (matches the web dashboard).
      total: this.currency.approxTotalInBase(allGroups, baseCurrency, rates),
      items,
    };
  }

  async statDetails(
    userId: string,
    categoryId: string | null,
    period: string,
    // An explicit date range overrides `period`; either bound may be omitted (open-ended).
    range?: { from?: Date; to?: Date },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, timezone: true },
    });
    const baseCurrency = user?.currency ?? 'USD';
    const { from, to } =
      range && (range.from || range.to)
        ? range
        : this.getPeriodDates(period, user?.timezone ?? 'UTC');

    const [incomes, rates] = await Promise.all([
      this.prisma.income.findMany({
        where: { userId, ...(categoryId ? { categoryId } : {}), date: { gte: from, lte: to } },
        select: {
          amount: true,
          amountUsd: true,
          currency: true,
          description: true,
          date: true,
          category: { select: { name: true, emoji: true } },
        },
        // Within a single day (date without time) keep the insertion order by createdAt.
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
      this.currency.getRates(),
    ]);

    // Per category keep the source rows (to recompute the total) and items (for display).
    const map = new Map<
      string,
      {
        emoji: string | null;
        rows: { currency: string; amount: number; amountUsd: number | null }[];
        items: { date: Date; amount: number; currency: string; description?: string }[];
      }
    >();
    const allRows: { currency: string; amount: number; amountUsd: number | null }[] = [];
    for (const e of incomes) {
      const name = e.category?.name ?? '—';
      let group = map.get(name);
      if (!group) {
        group = { emoji: e.category?.emoji ?? null, rows: [], items: [] };
        map.set(name, group);
      }
      const amount = Number(e.amount);
      const row = {
        currency: e.currency,
        amount,
        amountUsd: e.amountUsd != null ? Number(e.amountUsd) : null,
      };
      group.rows.push(row);
      allRows.push(row);
      // Show the item in the operation's ORIGINAL currency.
      group.items.push({ date: e.date, amount, currency: e.currency, description: e.description });
    }

    const categories = [...map.entries()].map(([category, group]) => ({
      category,
      emoji: group.emoji,
      // Category total — converted to the base currency in a single pass (as in the web dashboard).
      total: this.currency.approxTotalInBase(group.rows, baseCurrency, rates),
      items: group.items,
    }));

    return {
      baseCurrency,
      total: this.currency.approxTotalInBase(allRows, baseCurrency, rates),
      categories,
    };
  }

  // Period bounds in the user's "wall-clock" time (UTC components match how the date field is
  // stored), otherwise today's records with local time "ahead" of UTC get cut off at the `to`
  // boundary.
  private getPeriodDates(period: string, timezone: string): { from: Date; to: Date } {
    const now = localWallClockNow(timezone);
    if (period === 'day') {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { from, to: now };
    }
    if (period === 'week') {
      const from = new Date(now);
      from.setUTCDate(from.getUTCDate() - 7);
      return { from, to: now };
    }
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from, to: now };
  }
}
