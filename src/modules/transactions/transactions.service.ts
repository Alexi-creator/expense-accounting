import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService, type Rates } from '../currency/currency.service';
import { ExchangesService } from '../exchanges/exchanges.service';
import { GoalsService } from '../goals/goals.service';
import { GetTransactionsDto, TransactionType } from './dto/get-transactions.dto';

export interface TransactionRow {
  id: string;
  categoryId: string;
  categoryName: string | null;
  amount: number;
  currency: string;
  description: string;
  date: Date;
  createdAt: Date;
  type: 'income' | 'expense';
  // USD snapshot at creation time — internal, used for the summary; stripped from the response.
  amountUsd: number | null;
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
    private readonly goals: GoalsService,
    private readonly exchanges: ExchangesService,
  ) {}

  async findAll(userId: string, dto: GetTransactionsDto) {
    const { type, categoryId, search, currency, from, to } = dto;
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const expenseWhere = this.buildWhere('e', userId, categoryId, search, currency, from, to);
    const incomePart = this.buildWhere('i', userId, categoryId, search, currency, from, to);

    const expensePart = Prisma.sql`
      SELECT
        e.id,
        e.category_id AS "categoryId",
        ec.name AS "categoryName",
        e.amount::float8 AS amount,
        e.currency,
        e.description,
        e.date,
        e.created_at AS "createdAt",
        'expense'::text AS type,
        e.amount_usd::float8 AS "amountUsd"
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id = e.category_id
      WHERE ${expenseWhere}
    `;

    const incomePartQuery = Prisma.sql`
      SELECT
        i.id,
        i.category_id AS "categoryId",
        ic.name AS "categoryName",
        i.amount::float8 AS amount,
        i.currency,
        i.description,
        i.date,
        i.created_at AS "createdAt",
        'income'::text AS type,
        i.amount_usd::float8 AS "amountUsd"
      FROM incomes i
      LEFT JOIN income_categories ic ON ic.id = i.category_id
      WHERE ${incomePart}
    `;

    const union =
      type === TransactionType.EXPENSE
        ? expensePart
        : type === TransactionType.INCOME
          ? incomePartQuery
          : Prisma.sql`${expensePart} UNION ALL ${incomePartQuery}`;

    const [items, countResult, user, rates] = await Promise.all([
      this.prisma.$queryRaw<TransactionRow[]>`
        ${union}
        ORDER BY date DESC, "createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM (${union}) AS combined
      `,
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
    ]);

    const baseCurrency = user?.currency ?? 'USD';
    // The monetary total is computed over the current page (items), not the whole result set.
    const incomeRows = items.filter((r) => r.type === 'income');
    const expenseRows = items.filter((r) => r.type === 'expense');
    const income = this.currency.approxTotalInBase(incomeRows, baseCurrency, rates);
    const expense = this.currency.approxTotalInBase(expenseRows, baseCurrency, rates);
    // net is known only if both totals were computed (rates available).
    const net =
      income === null || expense === null ? null : Math.round((income - expense) * 100) / 100;

    return {
      // amountUsd is internal (used for the summary above) — keep it out of the response.
      items: items.map(({ amountUsd: _amountUsd, ...row }) => row),
      total: Number(countResult[0].count),
      page,
      limit,
      totalPages: Math.ceil(Number(countResult[0].count) / limit),
      summary: { baseCurrency, income, expense, net },
    };
  }

  /**
   * All-time balance.
   *
   * Money is summed inside each currency and never converted out of it: a THB balance is the
   * exact sum of THB rows, to the satang. Only what is genuinely held in another currency is
   * converted, once, at today's rate — because that is what it would be worth if sold today.
   *
   * The earlier version routed every row through its historical USD snapshot and converted the
   * net back at the current rate. That round-trip is lossy whenever rates moved between the
   * income dates and the expense dates (R_now * Sum(a_i / R_i) != Sum(a_i)), which quietly
   * distorted the balance of a user whose ledger is single-currency and needs no conversion at
   * all. `byCurrency` is the source of truth here; `balance` is a convenience total.
   */
  async getBalance(userId: string) {
    const [incomeGroups, expenseGroups, user, rates, goalRows, exchangeRows] = await Promise.all([
      this.prisma.income.groupBy({ by: ['currency'], where: { userId }, _sum: { amount: true } }),
      this.prisma.expense.groupBy({ by: ['currency'], where: { userId }, _sum: { amount: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
      this.goals.reservedRows(userId),
      this.exchanges.movementsByCurrency(userId),
    ]);

    const baseCurrency = user?.currency ?? 'USD';
    const round2 = (v: number) => Math.round(v * 100) / 100;

    // currency -> free balance in that currency (income - expense - reserved in active goals).
    // The base currency is always present, so an empty ledger reads as 0 rather than as nothing.
    const net = new Map<string, number>([[baseCurrency, 0]]);
    const add = (currency: string, amount: number) =>
      net.set(currency, (net.get(currency) ?? 0) + amount);
    for (const g of incomeGroups) add(g.currency, Number(g._sum.amount ?? 0));
    for (const g of expenseGroups) add(g.currency, -Number(g._sum.amount ?? 0));
    // Goals (model A - transfer): money allocated to an active goal is reserved, so it leaves the
    // free balance of its own currency.
    for (const r of goalRows) add(r.currency, -r.amount);
    // Exchanges move money between currencies at the rate the user actually got, so both sides are
    // exact figures and net worth is preserved without a single conversion of ours.
    for (const r of exchangeRows) add(r.currency, r.amount);

    const byCurrency = [...net]
      .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
      .filter((r) => r.amount !== 0 || r.currency === baseCurrency)
      .sort((a, b) =>
        a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : b.amount - a.amount,
      );

    const foreign = byCurrency.filter((r) => r.currency !== baseCurrency);
    const balance = this.sumIntoBase(byCurrency, baseCurrency, rates);
    const inGoals = this.sumIntoBase(
      goalRows.map((r) => ({ currency: r.currency, amount: r.amount })),
      baseCurrency,
      rates,
    );
    // The USD figure is a conversion of the single base-currency total, never its own aggregation:
    // two independent aggregations weight each row differently and can drift apart in magnitude
    // and even in sign once cross-currency rows are large next to a small net balance.
    const toUsd = (value: number | null): number | null => {
      if (value === null) return null;
      if (baseCurrency === 'USD') return value;
      if (!rates) return null;
      const usd = this.currency.convertWithRates(rates, value, baseCurrency, 'USD');
      return usd === null ? null : Math.round(usd * 100) / 100;
    };

    return {
      baseCurrency,
      balance,
      balanceUsd: toUsd(balance),
      // Exact per-currency figures — no conversion, no estimate.
      byCurrency,
      // `balance` involved a conversion, so it can only ever be an estimate.
      isApproximate: foreign.length > 0,
      inGoals,
      inGoalsUsd: toUsd(inGoals),
    };
  }

  /**
   * Sums per-currency amounts into the base currency: base-currency rows exactly as they are,
   * everything else at today's mid-market rate. null if a conversion was needed and rates were
   * unavailable (base-currency-only ledgers therefore never depend on the rates API).
   */
  private sumIntoBase(
    rows: { currency: string; amount: number }[],
    baseCurrency: string,
    rates: Rates | null,
  ): number | null {
    let sum = 0;
    for (const r of rows) {
      if (r.currency === baseCurrency) {
        sum += r.amount;
        continue;
      }
      if (!rates) return null;
      const inBase = this.currency.convertWithRates(rates, r.amount, r.currency, baseCurrency);
      if (inBase === null) return null;
      sum += inBase;
    }
    return Math.round(sum * 100) / 100;
  }

  private buildWhere(
    alias: string,
    userId: string,
    categoryId?: string[],
    search?: string,
    currency?: string[],
    from?: string,
    to?: string,
  ): Prisma.Sql {
    const a = Prisma.raw(alias);
    const conditions: Prisma.Sql[] = [Prisma.sql`${a}.user_id::text = ${userId}`];

    if (categoryId?.length) {
      conditions.push(Prisma.sql`${a}.category_id::text IN (${Prisma.join(categoryId)})`);
    }

    if (search) {
      conditions.push(Prisma.sql`${a}.description ILIKE ${`%${search}%`}`);
    }

    if (currency?.length) {
      conditions.push(Prisma.sql`${a}.currency IN (${Prisma.join(currency)})`);
    }

    // date — a DATE column (no time), compare bounds by day (inclusive on both sides).
    if (from) {
      conditions.push(Prisma.sql`${a}.date >= ${new Date(from)}::date`);
    }

    if (to) {
      conditions.push(Prisma.sql`${a}.date <= ${new Date(to)}::date`);
    }

    return Prisma.join(conditions, ' AND ');
  }
}
