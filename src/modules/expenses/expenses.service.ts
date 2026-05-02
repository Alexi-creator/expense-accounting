import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateExpenseDto) {
    return this.prisma.expense.create({ data: dto });
  }

  findAllByUser(userId: string, from?: Date, to?: Date) {
    return this.prisma.expense.findMany({
      where: {
        userId,
        ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
      },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!expense) throw new NotFoundException(`Expense ${id} not found`);
    return expense;
  }

  async update(id: string, dto: UpdateExpenseDto) {
    await this.findOne(id);
    return this.prisma.expense.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.expense.delete({ where: { id } });
  }

  async statSummary(userId: string, categoryId: string | null, period: string) {
    const { from, to } = this.getPeriodDates(period);
    const expenses = await this.prisma.expense.findMany({
      where: { userId, ...(categoryId ? { categoryId } : {}), createdAt: { gte: from, lte: to } },
      include: { category: true },
    });

    const map = new Map<string, number>();
    for (const e of expenses) {
      const name = e.category?.name ?? '—';
      map.set(name, (map.get(name) ?? 0) + Number(e.amount));
    }
    return Array.from(map.entries()).map(([category, total]) => ({ category, total }));
  }

  async statDetails(userId: string, categoryId: string | null, period: string) {
    const { from, to } = this.getPeriodDates(period);
    const expenses = await this.prisma.expense.findMany({
      where: { userId, ...(categoryId ? { categoryId } : {}), createdAt: { gte: from, lte: to } },
      include: { category: true },
      orderBy: { createdAt: 'asc' },
    });

    const map = new Map<string, { total: number; items: { date: Date; amount: number; description?: string }[] }>();
    for (const e of expenses) {
      const name = e.category?.name ?? '—';
      if (!map.has(name)) map.set(name, { total: 0, items: [] });
      const group = map.get(name);
      if (group) {
        group.total += Number(e.amount);
        group.items.push({ date: e.createdAt, amount: Number(e.amount), description: e.description ?? undefined });
      }
    }
    return Array.from(map.entries()).map(([category, data]) => ({ category, ...data }));
  }

  private getPeriodDates(period: string): { from: Date; to: Date } {
    const now = new Date();
    if (period === 'day') {
      return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: now };
    }
    if (period === 'week') {
      const from = new Date(now);
      from.setDate(from.getDate() - 7);
      return { from, to: now };
    }
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  }
}
