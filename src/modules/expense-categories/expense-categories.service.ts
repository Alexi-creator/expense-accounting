import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService, type DatedRow } from '../currency/currency.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { earliest, latest } from '../currency/summary.util';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { UpdateExpenseCategoryDto } from './dto/update-expense-category.dto';

/** Per-category spend stats. Comparison fields are present only when a compare range is requested. */
export interface CategoryStat {
  id: string;
  name: string;
  emoji: string | null;
  count: number;
  totals: { currency: string; total: number; count: number }[];
  baseCurrency: string;
  approxTotal: number | null;
  previousApproxTotal?: number | null;
  deltaApproxTotal?: number | null;
}

/** What one category's period looks like: dated rows to convert + exact per-currency figures. */
type CategoryRows = Map<
  string,
  { rows: DatedRow[]; byCurrency: Map<string, { amount: number; count: number }> }
>;

@Injectable()
export class ExpenseCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
    private readonly fx: FxRatesService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async create(userId: string, dto: CreateExpenseCategoryDto) {
    await this.subscriptions.assertCanAddCategory(userId);
    return this.prisma.expenseCategory.create({ data: { ...dto, userId } });
  }

  findAllByUser(userId: string) {
    return this.prisma.expenseCategory.findMany({ where: { userId } });
  }

  async statsByCategory(
    userId: string,
    range: { from?: Date; to?: Date; compareFrom?: Date; compareTo?: Date } = {},
  ): Promise<CategoryStat[]> {
    const { from, to, compareFrom, compareTo } = range;
    const compare = compareFrom !== undefined || compareTo !== undefined;

    const [categories, user, current, previous] = await Promise.all([
      this.prisma.expenseCategory.findMany({
        where: { userId },
        select: { id: true, name: true, emoji: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.groupByCategory(userId, from, to),
      compare ? this.groupByCategory(userId, compareFrom, compareTo) : Promise.resolve(null),
    ]);

    const baseCurrency = user?.currency ?? 'USD';
    // One rate lookup spanning both ranges. Every row is valued at the rate of its own date, so
    // the comparison is between two settled figures rather than two views of today's rate.
    const rowsOf = (byCategory: CategoryRows | null) =>
      [...(byCategory?.values() ?? [])].flatMap((g) => g.rows);
    const rateAt = await this.fx.resolverFor(
      [
        baseCurrency,
        ...rowsOf(current).map((r) => r.currency),
        ...rowsOf(previous).map((r) => r.currency),
      ],
      earliest(from, compare ? compareFrom : undefined),
      latest(to, compare ? compareTo : undefined),
    );

    return categories.map((c) => {
      const group = current.get(c.id);
      const approxTotal = this.currency.historicalTotalInBase(
        group?.rows ?? [],
        baseCurrency,
        rateAt,
      );
      const totals = [...(group?.byCurrency ?? [])].map(([currency, a]) => ({
        currency,
        total: a.amount,
        count: a.count,
      }));
      const base = {
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        count: totals.reduce((sum, t) => sum + t.count, 0),
        // Exact per-currency breakdown (different currencies are not summed).
        totals,
        baseCurrency,
        // Approximate amount in the base currency, each row at its own date's rate.
        approxTotal,
      };

      if (!previous) return base;

      // Comparison with the previous period: the previous period's total and the delta in the base currency.
      const previousApproxTotal = this.currency.historicalTotalInBase(
        previous.get(c.id)?.rows ?? [],
        baseCurrency,
        rateAt,
      );
      const deltaApproxTotal =
        approxTotal === null || previousApproxTotal === null
          ? null
          : Math.round((approxTotal - previousApproxTotal) * 100) / 100;
      return { ...base, previousApproxTotal, deltaApproxTotal };
    });
  }

  // categoryId -> the period's rows (per currency AND per date, so each can be valued at its own
  // date's rate) plus the per-currency breakdown the response displays as exact figures.
  private async groupByCategory(userId: string, from?: Date, to?: Date): Promise<CategoryRows> {
    const grouped = await this.prisma.expense.groupBy({
      by: ['categoryId', 'currency', 'date'],
      where: { userId, ...(from || to ? { date: { gte: from, lte: to } } : {}) },
      _sum: { amount: true, amountUsd: true },
      _count: { _all: true },
    });

    const map: CategoryRows = new Map();
    for (const g of grouped) {
      let entry = map.get(g.categoryId);
      if (!entry) {
        entry = { rows: [], byCurrency: new Map() };
        map.set(g.categoryId, entry);
      }
      const amount = Number(g._sum.amount ?? 0);
      entry.rows.push({
        currency: g.currency,
        amount,
        amountUsd: g._sum.amountUsd != null ? Number(g._sum.amountUsd) : null,
        date: g.date,
      });
      const acc = entry.byCurrency.get(g.currency) ?? { amount: 0, count: 0 };
      acc.amount = Math.round((acc.amount + amount) * 100) / 100;
      acc.count += g._count._all;
      entry.byCurrency.set(g.currency, acc);
    }
    return map;
  }

  async findOne(id: string, userId: string) {
    const category = await this.prisma.expenseCategory.findFirst({ where: { id, userId } });
    if (!category) throw new NotFoundException(`ExpenseCategory ${id} not found`);
    return category;
  }

  async update(id: string, userId: string, dto: UpdateExpenseCategoryDto) {
    await this.findOne(id, userId);
    return this.prisma.expenseCategory.update({ where: { id }, data: dto });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.expenseCategory.delete({ where: { id } });
  }
}
