import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateIncomeCategoryDto } from './dto/create-income-category.dto';
import { UpdateIncomeCategoryDto } from './dto/update-income-category.dto';

@Injectable()
export class IncomeCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async create(userId: string, dto: CreateIncomeCategoryDto) {
    await this.subscriptions.assertCanAddCategory(userId);
    return this.prisma.incomeCategory.create({ data: { ...dto, userId } });
  }

  findAllByUser(userId: string) {
    return this.prisma.incomeCategory.findMany({ where: { userId } });
  }

  async statsByCategory(
    userId: string,
    range: { from?: Date; to?: Date; compareFrom?: Date; compareTo?: Date } = {},
  ) {
    const { from, to, compareFrom, compareTo } = range;
    const compare = compareFrom !== undefined || compareTo !== undefined;

    const [categories, user, rates, current, previous] = await Promise.all([
      this.prisma.incomeCategory.findMany({
        where: { userId },
        select: { id: true, name: true, emoji: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
      this.groupByCategory(userId, from, to),
      compare ? this.groupByCategory(userId, compareFrom, compareTo) : Promise.resolve(null),
    ]);

    const baseCurrency = user?.currency ?? 'USD';

    return categories.map((c) => {
      const groups = current.get(c.id) ?? [];
      const approxTotal = this.currency.approxTotalInBase(groups, baseCurrency, rates);
      const base = {
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        count: groups.reduce((sum, g) => sum + g.count, 0),
        // Exact per-currency breakdown (different currencies are not summed).
        totals: groups.map((g) => ({ currency: g.currency, total: g.amount, count: g.count })),
        baseCurrency,
        // Approximate amount in the base currency via the USD snapshot.
        approxTotal,
      };

      if (!previous) return base;

      // Comparison with the previous period: the previous period's total and the delta in the base currency.
      const prevGroups = previous.get(c.id) ?? [];
      const previousApproxTotal = this.currency.approxTotalInBase(prevGroups, baseCurrency, rates);
      const deltaApproxTotal =
        approxTotal === null || previousApproxTotal === null
          ? null
          : Math.round((approxTotal - previousApproxTotal) * 100) / 100;
      return { ...base, previousApproxTotal, deltaApproxTotal };
    });
  }

  // categoryId -> per-currency breakdown for the period: amount + count + USD snapshot (for approx).
  private async groupByCategory(userId: string, from?: Date, to?: Date) {
    const grouped = await this.prisma.income.groupBy({
      by: ['categoryId', 'currency'],
      where: { userId, ...(from || to ? { date: { gte: from, lte: to } } : {}) },
      _sum: { amount: true, amountUsd: true },
      _count: { _all: true },
    });

    const map = new Map<
      string,
      { currency: string; amount: number; count: number; amountUsd: number | null }[]
    >();
    for (const g of grouped) {
      const list = map.get(g.categoryId) ?? [];
      list.push({
        currency: g.currency,
        amount: Number(g._sum.amount ?? 0),
        count: g._count._all,
        amountUsd: g._sum.amountUsd != null ? Number(g._sum.amountUsd) : null,
      });
      map.set(g.categoryId, list);
    }
    return map;
  }

  async findOne(id: string, userId: string) {
    const category = await this.prisma.incomeCategory.findFirst({ where: { id, userId } });
    if (!category) throw new NotFoundException(`IncomeCategory ${id} not found`);
    return category;
  }

  async update(id: string, userId: string, dto: UpdateIncomeCategoryDto) {
    await this.findOne(id, userId);
    return this.prisma.incomeCategory.update({ where: { id }, data: dto });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.incomeCategory.delete({ where: { id } });
  }
}
