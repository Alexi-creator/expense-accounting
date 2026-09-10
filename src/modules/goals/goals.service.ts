import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Goal, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from '../currency/currency.service';
import { CreateContributionDto } from './dto/create-contribution.dto';
import { CreateGoalDto } from './dto/create-goal.dto';
import {
  ContributionDto,
  GoalDto,
  GoalsResponseDto,
  GoalsSummaryDto,
} from './dto/goal-response.dto';
import { UpdateContributionDto } from './dto/update-contribution.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';

const round2 = (v: number) => Math.round(v * 100) / 100;

interface CurrencyRow {
  currency: string;
  amount: number;
  amountUsd: number | null;
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
  ) {}

  /** Goals page: active goals with computed fields + the top aggregate card. */
  async list(userId: string): Promise<GoalsResponseDto> {
    const goals = await this.prisma.goal.findMany({
      where: { userId, archived: false },
      orderBy: { createdAt: 'asc' },
    });

    const sums = await this.sumByGoal(userId);
    const now = new Date();
    const items = goals.map((g) => this.toDto(g, sums.get(g.id) ?? 0, now));
    const summary = await this.buildSummary(userId, goals, sums);
    return { items, summary };
  }

  async create(userId: string, dto: CreateGoalDto): Promise<GoalDto> {
    const goal = await this.prisma.goal.create({
      data: {
        userId,
        name: dto.name,
        emoji: dto.emoji ?? null,
        targetAmount: dto.targetAmount,
        currency: dto.currency,
        targetDate: dto.targetDate ?? null,
      },
    });
    return this.toDto(goal, 0, new Date());
  }

  async update(userId: string, id: string, dto: UpdateGoalDto): Promise<GoalDto> {
    await this.ownedGoal(userId, id);
    const goal = await this.prisma.goal.update({
      where: { id },
      data: {
        name: dto.name,
        emoji: dto.emoji,
        targetAmount: dto.targetAmount,
        currency: dto.currency,
        targetDate: dto.targetDate,
        archived: dto.archived,
      },
    });
    const current = (await this.sumByGoal(userId)).get(id) ?? 0;
    return this.toDto(goal, current, new Date());
  }

  async remove(userId: string, id: string): Promise<{ success: true }> {
    await this.ownedGoal(userId, id);
    await this.prisma.goal.delete({ where: { id } });
    return { success: true };
  }

  /** "+ Add funds". Creates a contribution and, on first reaching the target, fires the achievement notification. */
  async contribute(userId: string, goalId: string, dto: CreateContributionDto): Promise<GoalDto> {
    const goal = await this.ownedGoal(userId, goalId);
    const target = Number(goal.targetAmount);

    const before = (await this.sumByGoal(userId, goalId)).get(goalId) ?? 0;
    const after = round2(before + dto.amount);

    // Source of truth — never trust the client. Keep 0 <= currentAmount <= targetAmount.
    if (dto.amount === 0) {
      throw new BadRequestException('amount must not be zero');
    }
    if (after < 0) {
      throw new BadRequestException('Withdrawal exceeds the goal balance');
    }
    if (after > target) {
      throw new BadRequestException('Contribution would exceed the goal target');
    }

    await this.prisma.goalContribution.create({
      data: {
        goalId,
        userId,
        amount: dto.amount,
        note: dto.note ?? null,
        date: dto.date ?? new Date(),
      },
    });

    let completedGoal = goal;
    if (!goal.completedAt && after >= target) {
      completedGoal = await this.prisma.goal.update({
        where: { id: goalId },
        data: { completedAt: new Date() },
      });
      await this.notifyCompleted(userId, goal);
    }

    return this.toDto(completedGoal, after, new Date());
  }

  async listContributions(userId: string, goalId: string): Promise<ContributionDto[]> {
    await this.ownedGoal(userId, goalId);
    const rows = await this.prisma.goalContribution.findMany({
      where: { goalId, userId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      note: r.note,
      date: r.date,
      createdAt: r.createdAt,
    }));
  }

  async removeContribution(
    userId: string,
    goalId: string,
    contributionId: string,
  ): Promise<{ success: true }> {
    await this.ownedGoal(userId, goalId);
    const deleted = await this.prisma.goalContribution.deleteMany({
      where: { id: contributionId, goalId, userId },
    });
    if (deleted.count === 0) throw new NotFoundException('Contribution not found');
    return { success: true };
  }

  /** Edit a past contribution's amount/note/date (history correction). */
  async updateContribution(
    userId: string,
    goalId: string,
    contributionId: string,
    dto: UpdateContributionDto,
  ): Promise<GoalDto> {
    const goal = await this.ownedGoal(userId, goalId);
    const target = Number(goal.targetAmount);

    const existing = await this.prisma.goalContribution.findFirst({
      where: { id: contributionId, goalId, userId },
    });
    if (!existing) throw new NotFoundException('Contribution not found');

    const newAmount = dto.amount ?? Number(existing.amount);
    if (newAmount === 0) {
      throw new BadRequestException('amount must not be zero');
    }

    const before = (await this.sumByGoal(userId, goalId)).get(goalId) ?? 0;
    const after = round2(before - Number(existing.amount) + newAmount);

    // Same invariant as contribute(): 0 <= currentAmount <= targetAmount.
    if (after < 0) {
      throw new BadRequestException('Withdrawal exceeds the goal balance');
    }
    if (after > target) {
      throw new BadRequestException('Contribution would exceed the goal target');
    }

    await this.prisma.goalContribution.update({
      where: { id: contributionId },
      data: {
        amount: newAmount,
        note: dto.note !== undefined ? dto.note : existing.note,
        date: dto.date ?? existing.date,
      },
    });

    let completedGoal = goal;
    if (!goal.completedAt && after >= target) {
      completedGoal = await this.prisma.goal.update({
        where: { id: goalId },
        data: { completedAt: new Date() },
      });
      await this.notifyCompleted(userId, goal);
    }

    return this.toDto(completedGoal, after, new Date());
  }

  /**
   * Money reserved across active goals, as currency rows for CurrencyService.approxTotalInBase.
   * Used by the balance to subtract goal allocations from the free balance (model A — transfer).
   */
  async reservedRows(userId: string): Promise<CurrencyRow[]> {
    const goals = await this.prisma.goal.findMany({
      where: { userId, archived: false },
      select: { id: true, currency: true },
    });
    const sums = await this.sumByGoal(userId);
    return goals.map((g) => ({
      currency: g.currency,
      amount: sums.get(g.id) ?? 0,
      amountUsd: null,
    }));
  }

  // --- internals ---

  private async ownedGoal(userId: string, id: string): Promise<Goal> {
    const goal = await this.prisma.goal.findFirst({ where: { id, userId } });
    if (!goal) throw new NotFoundException('Goal not found');
    return goal;
  }

  /** Net contributed amount per goal (in the goal currency). Optionally scoped to one goal. */
  private async sumByGoal(userId: string, goalId?: string): Promise<Map<string, number>> {
    const grouped = await this.prisma.goalContribution.groupBy({
      by: ['goalId'],
      where: { userId, ...(goalId ? { goalId } : {}) },
      _sum: { amount: true },
    });
    return new Map(grouped.map((g) => [g.goalId, Number(g._sum.amount ?? 0)]));
  }

  private toDto(goal: Goal, currentAmount: number, now: Date): GoalDto {
    const target = Number(goal.targetAmount);
    const current = round2(currentAmount);
    const remaining = Math.max(round2(target - current), 0);
    const progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const isCompleted = current >= target;

    let monthsLeft: number | null = null;
    let perMonth: number | null = null;
    let isOverdue = false;
    if (goal.targetDate) {
      const diff =
        (goal.targetDate.getUTCFullYear() - now.getUTCFullYear()) * 12 +
        (goal.targetDate.getUTCMonth() - now.getUTCMonth());
      monthsLeft = Math.max(0, diff);
      isOverdue = !isCompleted && diff < 0;
      const divisor = monthsLeft > 0 ? monthsLeft : 1;
      perMonth = remaining > 0 ? round2(remaining / divisor) : 0;
    }

    return {
      id: goal.id,
      name: goal.name,
      emoji: goal.emoji,
      targetAmount: target,
      currentAmount: current,
      currency: goal.currency,
      targetDate: goal.targetDate,
      progress,
      remaining,
      monthsLeft,
      perMonth,
      isCompleted,
      isOverdue,
      archived: goal.archived,
      completedAt: goal.completedAt,
      createdAt: goal.createdAt,
    };
  }

  private async buildSummary(
    userId: string,
    goals: Goal[],
    sums: Map<string, number>,
  ): Promise<GoalsSummaryDto> {
    const [user, rates] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
      this.currency.getRates(),
    ]);
    const baseCurrency = user?.currency ?? 'USD';

    const toRow = (currency: string, amount: number): CurrencyRow => ({
      currency,
      amount,
      amountUsd: null,
    });
    const savedRows = goals.map((g) => toRow(g.currency, sums.get(g.id) ?? 0));
    const targetRows = goals.map((g) => toRow(g.currency, Number(g.targetAmount)));

    const totalSaved = this.currency.approxTotalInBase(savedRows, baseCurrency, rates);
    const totalTarget = this.currency.approxTotalInBase(targetRows, baseCurrency, rates);
    const totalRemaining =
      totalSaved !== null && totalTarget !== null
        ? Math.max(round2(totalTarget - totalSaved), 0)
        : null;
    const overallProgress =
      totalSaved !== null && totalTarget !== null && totalTarget > 0
        ? Math.min(100, Math.round((totalSaved / totalTarget) * 100))
        : null;

    return {
      baseCurrency,
      activeCount: goals.length,
      totalSaved,
      totalTarget,
      totalRemaining,
      overallProgress,
    };
  }

  private async notifyCompleted(userId: string, goal: Goal): Promise<void> {
    const dedupeKey = `goal_completed:${goal.id}`;
    const payload = { goalId: goal.id, name: goal.name } as Prisma.InputJsonValue;
    await this.prisma.notification.upsert({
      where: { userId_dedupeKey: { userId, dedupeKey } },
      update: {}, // already notified once — keep it idempotent
      // title/body are omitted: the frontend localizes from `payload`.
      create: {
        userId,
        type: 'goal_completed',
        dedupeKey,
        payload,
      },
    });
  }
}
