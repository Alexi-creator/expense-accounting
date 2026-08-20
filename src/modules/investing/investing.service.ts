import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExchangeAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BybitClient } from './bybit.client';
import { decryptSecret, encryptSecret } from './crypto.util';
import type { CreateExchangeAccountDto } from './dto/create-exchange-account.dto';
import type { CreateHoldingDto, UpdateHoldingDto } from './dto/holding.dto';
import type { CreateManualPositionDto, UpdateManualPositionDto } from './dto/manual-position.dto';
import type { CreatePositionNoteDto, UpdatePositionNoteDto } from './dto/position-note.dto';
import type { UpdateExchangeAccountDto } from './dto/update-exchange-account.dto';
import { InvestingSyncService } from './investing-sync.service';
import { PriceService } from './price.service';

const MAX_PAGE = 200;
// Bybit hard-rejects startTime older than 2 years ("Bybit error 10001: Can't query order
// earlier than 2 years") instead of just returning an empty page, so the whole sync fails if
// this isn't kept under that — a few days of margin absorbs any rounding on Bybit's side.
const MAX_HISTORY_MS = 729 * 24 * 60 * 60 * 1000;

const round2 = (n: number) => Math.round(n * 100) / 100;

// All rows share the exchange convention: side is the CLOSING order's side.
const directionToSide = (direction: 'long' | 'short') => (direction === 'long' ? 'Sell' : 'Buy');
const sideToDirection = (side: string): 'long' | 'short' => (side === 'Sell' ? 'long' : 'short');

// PnL from prices when the user doesn't provide it (fees not included then).
const computePnl = (direction: 'long' | 'short', qty: number, entry: number, exit: number) =>
  direction === 'long' ? (exit - entry) * qty : (entry - exit) * qty;

type ListQuery = {
  accountId?: string;
  symbol?: string;
  status?: 'OPEN' | 'CLOSED';
  category?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  /** Currently in profit/loss — realized (closedPnl) for CLOSED rows, live (currentPrice vs
   *  avgEntryPrice) for OPEN ones. See applyPnlFilter. */
  pnl?: 'positive' | 'negative';
};

@Injectable()
export class InvestingService {
  private readonly logger = new Logger(InvestingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bybit: BybitClient,
    private readonly sync: InvestingSyncService,
    private readonly prices: PriceService,
    private readonly config: ConfigService,
  ) {}

  async addAccount(userId: string, dto: CreateExchangeAccountDto) {
    const key = this.encryptionKey();

    // Reject broken/foreign keys immediately — a bad key must fail at connect time,
    // not silently in the background sync.
    let readOnly: boolean;
    try {
      ({ readOnly } = await this.bybit.validateKey({
        apiKey: dto.apiKey,
        apiSecret: dto.apiSecret,
      }));
    } catch (err) {
      this.logger.warn(`Bybit key validation failed for user ${userId}: ${err}`);
      throw new BadRequestException('Bybit rejected the API key. Check the key and secret.');
    }

    // The diary only ever reads, so a key with trade/withdraw permissions is pure liability —
    // refuse it outright rather than storing more power than we need.
    if (!readOnly) {
      throw new BadRequestException(
        'This API key has trade permissions. Create a read-only key on Bybit and connect that instead.',
      );
    }

    const account = await this.prisma.exchangeAccount.create({
      data: {
        userId,
        exchange: 'bybit',
        label: dto.label,
        apiKey: encryptSecret(dto.apiKey, key),
        apiSecret: encryptSecret(dto.apiSecret, key),
        // Backfill as much as Bybit will actually hand over, not just from registration.
        syncFrom: new Date(Date.now() - MAX_HISTORY_MS),
      },
    });

    // Backfill in the background; the UI sees progress via status/lastSyncAt.
    this.sync.syncAccountById(account.id).catch((err) => {
      this.logger.warn(`Initial sync failed for account ${account.id}: ${err}`);
    });

    return { ...this.sanitize(account), readOnly };
  }

  async listAccounts(userId: string) {
    const accounts = await this.prisma.exchangeAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((a) => this.sanitize(a));
  }

  async removeAccount(userId: string, id: string) {
    await this.findOwnAccount(userId, id);
    // Cascade wipes the synced executions/positions — reconnecting re-syncs them.
    await this.prisma.exchangeAccount.delete({ where: { id } });
    return { deleted: true };
  }

  async renameAccount(userId: string, id: string, dto: UpdateExchangeAccountDto) {
    await this.findOwnAccount(userId, id);
    const account = await this.prisma.exchangeAccount.update({
      where: { id },
      data: { label: dto.label },
    });
    return this.sanitize(account);
  }

  async syncNow(userId: string, id: string) {
    const account = await this.findOwnAccount(userId, id);
    try {
      await this.sync.syncAccount(account);
    } catch (err) {
      // syncAccount already persisted status=ERROR/lastError before rethrowing — surface that
      // same reason (e.g. Bybit's IP-whitelist rejection) instead of a bare, unexplained 500.
      throw new BadGatewayException(err instanceof Error ? err.message : 'Sync failed');
    }
    return this.sanitize(await this.prisma.exchangeAccount.findUniqueOrThrow({ where: { id } }));
  }

  async getPositions(userId: string, query: ListQuery) {
    const where = await this.applyPnlFilter(userId, query, this.buildPositionsWhere(userId, query));
    const [rows, total] = await Promise.all([
      this.prisma.position.findMany({
        where,
        // One chronological timeline by entry date — open and closed, spot and linear, all
        // interleaved — rather than bucketed by status first. closedAt is the tiebreaker for the
        // rare rows with no derivable openedAt (see Position.openedAt).
        orderBy: [{ openedAt: 'desc' }, { closedAt: 'desc' }],
        include: { notes: { orderBy: { createdAt: 'asc' } } },
        take: Math.min(query.limit ?? 50, MAX_PAGE),
        skip: query.offset ?? 0,
      }),
      this.prisma.position.count({ where }),
    ]);

    // Only worth hitting a price cache when this page actually has an open position that needs
    // it, and only the feed(s) it needs — linear positions price off their own feed (see
    // priceFor below), spot/manual off the bare-asset one.
    const openRows = rows.filter((p) => p.status === 'OPEN');
    const [spotPrices, linearPrices] = await Promise.all([
      openRows.some((p) => p.category !== 'linear') ? this.prices.getUsdPrices() : null,
      openRows.some((p) => p.category === 'linear') ? this.prices.getLinearPrices() : null,
    ]);

    const items = await Promise.all(
      rows.map(async (p) => {
        const notional = Number(p.qty) * Number(p.avgEntryPrice);
        const leverage = p.leverage ? Number(p.leverage) : 1;
        const currentPrice =
          p.status === 'OPEN' ? this.priceFor(p, spotPrices, linearPrices) : null;
        const unrealizedPnl =
          currentPrice !== null
            ? round2(
                computePnl(
                  sideToDirection(p.side),
                  Number(p.qty),
                  Number(p.avgEntryPrice),
                  currentPrice,
                ),
              )
            : null;
        return {
          ...p,
          // Capital actually committed, in USDT — notional at entry price divided by leverage,
          // fees aside. 1x for spot/manual (no leverage).
          entryVolumeUsd: round2(notional / leverage),
          totalFeeUsd: await this.sumFees(p),
          currentPrice,
          unrealizedPnl,
        };
      }),
    );
    return { items, total };
  }

  // Synced positions (spot/linear) carry the exchange's own trading-pair symbol, which is
  // already the exact key its ticker feed uses — including oddities like SHIB1000USDT, where
  // guessing a bare asset ticker back out would silently misprice (see getLinearTickers). So
  // those look the symbol up directly, one map per category. Manual entries have no such
  // guarantee — symbol is whatever the user typed — so that's the one case still routed through
  // priceOf's "bare asset + USDT" convention, same as Holdings.
  private priceFor(
    position: { symbol: string; category: string },
    spotPrices: Map<string, number> | null,
    linearPrices: Map<string, number> | null,
  ): number | null {
    if (position.category === 'linear') return linearPrices?.get(position.symbol) ?? null;
    if (position.category === 'spot') return spotPrices?.get(position.symbol) ?? null;
    return spotPrices ? this.prices.priceOf(this.baseAssetOf(position.symbol), spotPrices) : null;
  }

  // Peels the quote currency off a bare-ish symbol for the manual-entry price lookup above —
  // PriceService.priceOf expects just the asset ("BTC") and appends "USDT" itself.
  private baseAssetOf(symbol: string): string {
    const s = symbol.toUpperCase();
    return s.endsWith('USDT') ? s.slice(0, -4) : s;
  }

  // CLOSED rows filter on the stored closedPnl column directly. OPEN rows have no stored PnL
  // (see getPositions' currentPrice/unrealizedPnl comment) — matching them means pricing every
  // open row up front (open counts are small, tens per user typically) and filtering by id,
  // rather than pushing the comparison into SQL. Skipped entirely when the query already narrows
  // to status=CLOSED, since the open branch would only end up excluded by that AND anyway.
  private async applyPnlFilter(
    userId: string,
    query: ListQuery,
    where: Prisma.PositionWhereInput,
  ): Promise<Prisma.PositionWhereInput> {
    if (!query.pnl) return where;
    const cmp = query.pnl === 'positive' ? { gt: 0 } : { lt: 0 };
    const branches: Prisma.PositionWhereInput[] = [{ status: 'CLOSED', closedPnl: cmp }];
    if (query.status !== 'CLOSED') {
      const openIds = await this.openIdsMatchingPnlSign(userId, query, query.pnl);
      branches.push({ id: { in: openIds } });
    }
    return { AND: [where, { OR: branches }] };
  }

  // Live PnL isn't stored, so matching OPEN rows against a sign means pricing all of them
  // up front (bounded by how many positions a user has open at once) instead of a WHERE clause.
  private async openIdsMatchingPnlSign(
    userId: string,
    query: ListQuery,
    sign: 'positive' | 'negative',
  ): Promise<string[]> {
    const where = this.buildPositionsWhere(userId, { ...query, pnl: undefined, status: 'OPEN' });
    const openPositions = await this.prisma.position.findMany({
      where,
      select: {
        id: true,
        symbol: true,
        category: true,
        side: true,
        qty: true,
        avgEntryPrice: true,
      },
    });
    if (openPositions.length === 0) return [];

    const [spotPrices, linearPrices] = await Promise.all([
      openPositions.some((p) => p.category !== 'linear') ? this.prices.getUsdPrices() : null,
      openPositions.some((p) => p.category === 'linear') ? this.prices.getLinearPrices() : null,
    ]);

    return openPositions
      .filter((p) => {
        const currentPrice = this.priceFor(p, spotPrices, linearPrices);
        if (currentPrice === null) return false;
        const pnl = computePnl(
          sideToDirection(p.side),
          Number(p.qty),
          Number(p.avgEntryPrice),
          currentPrice,
        );
        return sign === 'positive' ? pnl > 0 : pnl < 0;
      })
      .map((p) => p.id);
  }

  // dateField defaults to openedAt so the from/to range picks trades by when they were entered —
  // open/closed is a separate concern, surfaced via `status` (filter or badge in the UI), not by
  // the date range hiding still-open trades outside it. getEquityCurve overrides this to closedAt
  // since that chart plots realized PnL over the date it actually landed, not when the trade began.
  private buildPositionsWhere(
    userId: string,
    query: ListQuery,
    dateField: 'openedAt' | 'closedAt' = 'openedAt',
  ) {
    return {
      userId,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      // Partial match — symbols are always stored uppercased, so uppercasing the query is enough
      // to make this case-insensitive without a Postgres `mode: 'insensitive'` (slower, no index).
      ...(query.symbol ? { symbol: { contains: query.symbol.toUpperCase() } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.from || query.to ? { [dateField]: { gte: query.from, lte: query.to } } : {}),
    };
  }

  // Total realized profit + win/loss breakdown across the FULL filtered history (no MAX_PAGE
  // cap) — getPositions' `items` is paginated for display and must never be summed/counted
  // client-side for "total profit" or "winrate".
  async getPositionsSummary(userId: string, query: Omit<ListQuery, 'limit' | 'offset'>) {
    const where = await this.applyPnlFilter(userId, query, this.buildPositionsWhere(userId, query));
    const closedWhere = { ...where, status: 'CLOSED' as const };
    const [pnlAgg, statusCounts, winCount, lossCount] = await Promise.all([
      this.prisma.position.aggregate({ where, _sum: { closedPnl: true } }),
      this.prisma.position.groupBy({ by: ['status'], where, _count: true }),
      this.prisma.position.count({ where: { ...closedWhere, closedPnl: { gt: 0 } } }),
      this.prisma.position.count({ where: { ...closedWhere, closedPnl: { lt: 0 } } }),
    ]);
    const openCount = statusCounts.find((s) => s.status === 'OPEN')?._count ?? 0;
    const closedCount = statusCounts.find((s) => s.status === 'CLOSED')?._count ?? 0;

    return {
      totalPnl: pnlAgg._sum.closedPnl ? round2(Number(pnlAgg._sum.closedPnl)) : 0,
      openCount,
      closedCount,
      winCount,
      lossCount,
      // closedPnl === 0 exactly — neither a win nor a loss.
      breakevenCount: Math.max(closedCount - winCount - lossCount, 0),
    };
  }

  // Ordered (closedAt, closedPnl) pairs for the cumulative-PnL chart — the FULL closed history,
  // no MAX_PAGE cap. Deliberately narrow (two fields only): getPositions' `items` is paginated
  // for the diary table and must never be the source for a chart spanning the whole history.
  async getEquityCurve(userId: string, query: Omit<ListQuery, 'status' | 'limit' | 'offset'>) {
    const where = this.buildPositionsWhere(userId, { ...query, status: 'CLOSED' }, 'closedAt');
    const rows = await this.prisma.position.findMany({
      where,
      select: { closedAt: true, closedPnl: true },
      orderBy: { closedAt: 'asc' },
    });
    return {
      items: rows.map((r) => ({
        closedAt: r.closedAt as Date,
        closedPnl: r.closedPnl ? Number(r.closedPnl) : 0,
      })),
    };
  }

  // Distinct symbols the user has ever traded (any account/category/status) — for the diary's
  // Pair filter autocomplete. Deliberately not scoped to the current filter selection: the point
  // is to help pick a value for the symbol field, not to reflect what's already filtered.
  async getPositionSymbols(userId: string): Promise<string[]> {
    const rows = await this.prisma.position.findMany({
      where: { userId },
      select: { symbol: true },
      distinct: ['symbol'],
      orderBy: { symbol: 'asc' },
    });
    return rows.map((r) => r.symbol);
  }

  // Every fee (trading + funding) charged over the position's life, signed as Bybit reports it
  // (positive = paid, negative = rebate) — a plain sum reads as "net cost". Only computable for
  // synced, closed positions with a known open time; manual entries, still-open positions and
  // undated linear ones get null.
  private async sumFees(p: {
    source: string;
    accountId: string | null;
    symbol: string;
    category: string;
    openedAt: Date | null;
    closedAt: Date | null;
  }): Promise<number | null> {
    if (p.source !== 'bybit' || !p.accountId || !p.openedAt || !p.closedAt) return null;
    const agg = await this.prisma.tradeExecution.aggregate({
      where: {
        accountId: p.accountId,
        symbol: p.symbol,
        category: p.category,
        execTime: { gte: p.openedAt, lte: p.closedAt },
      },
      _sum: { fee: true },
    });
    return agg._sum.fee ? round2(Number(agg._sum.fee)) : 0;
  }

  async getTrades(userId: string, query: ListQuery) {
    const where = this.buildWhere(userId, query, 'execTime');
    // Funding-fee settlements are excluded from the fills themselves and rolled up into a
    // separate summary — they clutter the fill list (one row every 8h) and read as trades
    // (side Buy/Sell) even though no trading actually happened.
    const tradesWhere = { ...where, execType: { not: 'Funding' } };
    const fundingWhere = { ...where, execType: 'Funding' };

    const [items, total, fundingAgg] = await Promise.all([
      this.prisma.tradeExecution.findMany({
        where: tradesWhere,
        orderBy: { execTime: 'desc' },
        take: Math.min(query.limit ?? 50, MAX_PAGE),
        skip: query.offset ?? 0,
      }),
      this.prisma.tradeExecution.count({ where: tradesWhere }),
      this.prisma.tradeExecution.aggregate({
        where: fundingWhere,
        _sum: { fee: true },
        _count: true,
      }),
    ]);

    return {
      items,
      total,
      funding: {
        totalFee: fundingAgg._sum.fee ? Number(fundingAgg._sum.fee) : 0,
        count: fundingAgg._count,
      },
    };
  }

  // ─── Manual diary entries (trades outside connected exchanges) ───

  async addManualPosition(userId: string, dto: CreateManualPositionDto) {
    if ((dto.exitPrice === undefined) !== (dto.closedAt === undefined)) {
      throw new BadRequestException(
        'exitPrice and closedAt must be given together, or both omitted to log the trade as still open',
      );
    }
    const exitPrice = dto.exitPrice;
    const closedAt = dto.closedAt;

    return this.prisma.position.create({
      data: {
        userId,
        source: 'manual',
        status: exitPrice !== undefined && closedAt !== undefined ? 'CLOSED' : 'OPEN',
        symbol: dto.symbol.toUpperCase(),
        category: 'manual',
        side: directionToSide(dto.direction),
        qty: dto.qty,
        avgEntryPrice: dto.entryPrice,
        avgExitPrice: exitPrice ?? null,
        closedPnl:
          exitPrice !== undefined && closedAt !== undefined
            ? (dto.closedPnl ?? computePnl(dto.direction, dto.qty, dto.entryPrice, exitPrice))
            : null,
        leverage: dto.leverage ?? null,
        takeProfitPrice: dto.takeProfitPrice ?? null,
        stopLossPrice: dto.stopLossPrice ?? null,
        openedAt: dto.openedAt ?? null,
        closedAt: closedAt ?? null,
        raw: dto.venue ? { venue: dto.venue } : undefined,
        notes: dto.note
          ? { create: { userId, body: dto.note, imageUrl: dto.noteImageUrl ?? null } }
          : undefined,
      },
      include: { notes: true },
    });
  }

  async updateManualPosition(userId: string, id: string, dto: UpdateManualPositionDto) {
    const existing = await this.findOwnManualPosition(userId, id);

    const direction = dto.direction ?? sideToDirection(existing.side);
    const qty = dto.qty ?? Number(existing.qty);
    const entry = dto.entryPrice ?? Number(existing.avgEntryPrice);
    const resultExit =
      dto.exitPrice ?? (existing.avgExitPrice !== null ? Number(existing.avgExitPrice) : undefined);
    const resultClosedAt = dto.closedAt ?? existing.closedAt ?? undefined;

    // Touching either closing field without the other being resolvable (from this edit or the
    // existing row) would leave a half-closed trade — reject rather than guess.
    if ((resultExit === undefined) !== (resultClosedAt === undefined)) {
      throw new BadRequestException(
        'exitPrice and closedAt must both end up set (or both stay unset) — provide the missing one together with this edit',
      );
    }

    // Explicit PnL wins; otherwise recompute only when an input actually changed — an untouched
    // trade must keep its (possibly hand-adjusted) PnL. Still-open trades have no PnL yet.
    const inputsChanged =
      dto.direction !== undefined ||
      dto.qty !== undefined ||
      dto.entryPrice !== undefined ||
      dto.exitPrice !== undefined;
    let closedPnl: number | null | undefined;
    if (resultExit === undefined) {
      closedPnl = null;
    } else if (dto.closedPnl !== undefined) {
      closedPnl = dto.closedPnl;
    } else if (inputsChanged) {
      closedPnl = computePnl(direction, qty, entry, resultExit);
    }

    return this.prisma.position.update({
      where: { id },
      data: {
        ...(dto.symbol !== undefined ? { symbol: dto.symbol.toUpperCase() } : {}),
        ...(dto.direction !== undefined ? { side: directionToSide(dto.direction) } : {}),
        ...(dto.qty !== undefined ? { qty: dto.qty } : {}),
        ...(dto.entryPrice !== undefined ? { avgEntryPrice: dto.entryPrice } : {}),
        ...(dto.exitPrice !== undefined ? { avgExitPrice: dto.exitPrice } : {}),
        ...(closedPnl !== undefined ? { closedPnl } : {}),
        ...(dto.leverage !== undefined ? { leverage: dto.leverage } : {}),
        ...(dto.takeProfitPrice !== undefined ? { takeProfitPrice: dto.takeProfitPrice } : {}),
        ...(dto.stopLossPrice !== undefined ? { stopLossPrice: dto.stopLossPrice } : {}),
        ...(dto.openedAt !== undefined ? { openedAt: dto.openedAt } : {}),
        ...(dto.closedAt !== undefined ? { closedAt: dto.closedAt } : {}),
        // A still-open manual entry flips to CLOSED the moment both closing fields resolve;
        // there's no path back from CLOSED to OPEN through this DTO.
        ...(existing.status === 'OPEN' && resultExit !== undefined
          ? { status: 'CLOSED' as const }
          : {}),
      },
    });
  }

  async removeManualPosition(userId: string, id: string) {
    await this.findOwnManualPosition(userId, id);
    await this.prisma.position.delete({ where: { id } });
    return { deleted: true };
  }

  private async findOwnManualPosition(userId: string, id: string) {
    const position = await this.prisma.position.findFirst({ where: { id, userId } });
    if (!position) throw new NotFoundException(`Position ${id} not found`);
    if (position.source !== 'manual') {
      throw new BadRequestException(
        'Only manual entries can be edited or deleted; synced positions are managed by the exchange sync',
      );
    }
    return position;
  }

  // ─── Journal notes (entry reason, updates, exit reason — on any position, any source/status) ───

  async addPositionNote(userId: string, positionId: string, dto: CreatePositionNoteDto) {
    await this.findOwnPosition(userId, positionId);
    return this.prisma.positionNote.create({
      data: { positionId, userId, body: dto.body, imageUrl: dto.imageUrl ?? null },
    });
  }

  async updatePositionNote(
    userId: string,
    positionId: string,
    noteId: string,
    dto: UpdatePositionNoteDto,
  ) {
    await this.findOwnPosition(userId, positionId);
    await this.findOwnNote(userId, positionId, noteId);
    return this.prisma.positionNote.update({
      where: { id: noteId },
      data: {
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
      },
    });
  }

  async removePositionNote(userId: string, positionId: string, noteId: string) {
    await this.findOwnPosition(userId, positionId);
    await this.findOwnNote(userId, positionId, noteId);
    await this.prisma.positionNote.delete({ where: { id: noteId } });
    return { deleted: true };
  }

  private async findOwnPosition(userId: string, id: string) {
    const position = await this.prisma.position.findFirst({ where: { id, userId } });
    if (!position) throw new NotFoundException(`Position ${id} not found`);
    return position;
  }

  private async findOwnNote(userId: string, positionId: string, noteId: string) {
    const note = await this.prisma.positionNote.findFirst({
      where: { id: noteId, positionId, userId },
    });
    if (!note) throw new NotFoundException(`Note ${noteId} not found`);
    return note;
  }

  // ─── Holdings (manually tracked portfolio) ───

  async addHolding(userId: string, dto: CreateHoldingDto) {
    return this.prisma.holding.create({
      data: {
        userId,
        asset: dto.asset.toUpperCase(),
        amount: dto.amount,
        avgBuyPrice: dto.avgBuyPrice ?? null,
        location: dto.location ?? '',
        note: dto.note ?? null,
      },
    });
  }

  // Holdings valued at current market prices. price/value/pnl are null when the asset has no
  // USDT ticker on Bybit or prices are temporarily unavailable.
  async listHoldings(userId: string) {
    const [holdings, prices] = await Promise.all([
      this.prisma.holding.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prices.getUsdPrices(),
    ]);

    let totalValue = 0;
    const items = holdings.map((h) => {
      const price = prices ? this.prices.priceOf(h.asset, prices) : null;
      const amount = Number(h.amount);
      const avgBuy = h.avgBuyPrice !== null ? Number(h.avgBuyPrice) : null;
      const value = price !== null ? round2(amount * price) : null;
      if (value !== null) totalValue += value;
      return {
        ...h,
        price,
        value,
        pnlUsd: price !== null && avgBuy !== null ? round2((price - avgBuy) * amount) : null,
        pnlPct: price !== null && avgBuy !== null ? round2((price / avgBuy - 1) * 100) : null,
      };
    });

    return { items, totalValue: round2(totalValue) };
  }

  async updateHolding(userId: string, id: string, dto: UpdateHoldingDto) {
    await this.findOwnHolding(userId, id);
    return this.prisma.holding.update({
      where: { id },
      data: {
        ...(dto.asset !== undefined ? { asset: dto.asset.toUpperCase() } : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.avgBuyPrice !== undefined ? { avgBuyPrice: dto.avgBuyPrice } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
    });
  }

  async removeHolding(userId: string, id: string) {
    await this.findOwnHolding(userId, id);
    await this.prisma.holding.delete({ where: { id } });
    return { deleted: true };
  }

  private async findOwnHolding(userId: string, id: string) {
    const holding = await this.prisma.holding.findFirst({ where: { id, userId } });
    if (!holding) throw new NotFoundException(`Holding ${id} not found`);
    return holding;
  }

  private buildWhere(userId: string, query: ListQuery, dateField: 'closedAt' | 'execTime') {
    return {
      userId,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.symbol ? { symbol: query.symbol.toUpperCase() } : {}),
      ...(query.from || query.to ? { [dateField]: { gte: query.from, lte: query.to } } : {}),
    };
  }

  private async findOwnAccount(userId: string, id: string) {
    const account = await this.prisma.exchangeAccount.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException(`Exchange account ${id} not found`);
    return account;
  }

  private encryptionKey(): string {
    const key = this.config.get<string>('ENCRYPTION_KEY');
    if (!key) {
      throw new ServiceUnavailableException(
        'Investing is not configured on this server (ENCRYPTION_KEY missing)',
      );
    }
    return key;
  }

  // Secrets never leave the server; the key is shown masked (last 4 chars) for recognition.
  private sanitize(account: ExchangeAccount) {
    const key = this.config.get<string>('ENCRYPTION_KEY');
    let apiKeyMasked: string | null = null;
    if (key) {
      try {
        apiKeyMasked = `••••${decryptSecret(account.apiKey, key).slice(-4)}`;
      } catch {
        apiKeyMasked = null; // encryption key rotated — the account needs reconnecting
      }
    }
    return {
      id: account.id,
      exchange: account.exchange,
      label: account.label,
      status: account.status,
      lastError: account.lastError,
      apiKeyMasked,
      syncFrom: account.syncFrom,
      lastSyncAt: account.lastSyncAt,
      createdAt: account.createdAt,
    };
  }
}
