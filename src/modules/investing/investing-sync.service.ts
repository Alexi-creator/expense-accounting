import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { ExchangeAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BybitClient, type BybitCredentials } from './bybit.client';
import { decryptSecret } from './crypto.util';
import { deriveLinearOpenedAt } from './linear-fifo.util';
import { flipSide } from './side.util';
import { computeSpotPositions } from './spot-lifo.util';
import { TradeCloseNotifierService } from './trade-close-notifier.service';

// Bybit limits one range query to 7 days; we step through history in such windows.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Re-scan a little before the cursor so records landing exactly on the boundary are never
// skipped; upserts make the overlap harmless.
const OVERLAP_MS = 60 * 1000;
// Closed PnL exists only for derivatives; spot PnL is derived from fills (see spot-lifo.util).
const PNL_CATEGORY = 'linear';
const EXECUTION_CATEGORIES = ['linear', 'spot'];

@Injectable()
export class InvestingSyncService {
  private readonly logger = new Logger(InvestingSyncService.name);
  // The cron may tick while a long backfill is still running — skip instead of piling up.
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bybit: BybitClient,
    private readonly config: ConfigService,
    private readonly tradeCloseNotifier: TradeCloseNotifierService,
  ) {}

  @Cron('*/2 * * * *')
  async syncAll() {
    if (this.running) return;
    if (!this.config.get<string>('ENCRYPTION_KEY')) return; // investing feature not configured

    this.running = true;
    try {
      // ERROR accounts are retried too: most failures (network, Bybit maintenance) are transient.
      const accounts = await this.prisma.exchangeAccount.findMany({
        where: { status: { in: ['ACTIVE', 'ERROR'] }, exchange: 'bybit' },
      });
      for (const account of accounts) {
        await this.syncAccount(account).catch((err) => {
          this.logger.warn(`Sync failed for account ${account.id}: ${err}`);
        });
      }
    } finally {
      this.running = false;
    }
  }

  async syncAccountById(id: string) {
    const account = await this.prisma.exchangeAccount.findUnique({ where: { id } });
    if (account) await this.syncAccount(account);
  }

  async syncAccount(account: ExchangeAccount) {
    const key = this.config.get<string>('ENCRYPTION_KEY');
    if (!key) throw new Error('ENCRYPTION_KEY is not configured');

    const creds: BybitCredentials = {
      apiKey: decryptSecret(account.apiKey, key),
      apiSecret: decryptSecret(account.apiSecret, key),
    };

    // Captured before this run mutates anything: "positions closed since the last successful
    // sync" is exactly the newly-closed set to notify about. NULL means this is the account's
    // first-ever sync (full history backfill) — skip notifying entirely so connecting an account
    // with months of history doesn't fire a wave of pushes for old trades.
    const previousSyncAt = account.lastSyncAt;

    try {
      const now = new Date();
      // Closed-pnl runs first so it can flip an existing OPEN row to CLOSED in place; only
      // afterwards do we ask Bybit what's still open, so a position closed moments ago isn't
      // re-created as a fresh OPEN row.
      await this.syncClosedPnl(account, creds, now);
      await this.syncOpenPositions(account, creds);
      await this.syncExecutions(account, creds, now);
      await this.rebuildSpotPositions(account);
      await this.rebuildLinearOpenedAt(account);
      if (previousSyncAt) {
        await this.tradeCloseNotifier.notifyNewlyClosed(account.id, previousSyncAt);
      }
      await this.prisma.exchangeAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: now, status: 'ACTIVE', lastError: null },
      });
    } catch (err) {
      await this.prisma.exchangeAccount.update({
        where: { id: account.id },
        data: { status: 'ERROR', lastError: String(err) },
      });
      throw err;
    }
  }

  private async syncClosedPnl(account: ExchangeAccount, creds: BybitCredentials, now: Date) {
    for (const window of this.windows(account.closedPnlSyncedTo, account.syncFrom, now)) {
      let cursor: string | undefined;
      do {
        const page = await this.bybit.getClosedPnl(creds, {
          category: PNL_CATEGORY,
          startTime: window.from.getTime(),
          endTime: window.to.getTime(),
          cursor,
        });
        for (const rec of page.list) {
          const data = {
            userId: account.userId,
            symbol: rec.symbol,
            category: PNL_CATEGORY,
            status: 'CLOSED' as const,
            orderId: rec.orderId,
            side: rec.side,
            qty: rec.qty,
            avgEntryPrice: rec.avgEntryPrice,
            avgExitPrice: rec.avgExitPrice,
            closedPnl: rec.closedPnl,
            leverage: rec.leverage || null,
            closedAt: new Date(Number(rec.updatedTime)),
            raw: rec as Prisma.InputJsonValue,
          };

          // Prefer flipping the OPEN row this position was tracked under (from
          // syncOpenPositions) into CLOSED, rather than creating a second row — that's the row
          // the user may have already attached journal notes to. Only one open row per
          // (account, symbol, category) is expected under one-way position mode.
          const openRow = await this.prisma.position.findFirst({
            where: {
              accountId: account.id,
              symbol: rec.symbol,
              category: PNL_CATEGORY,
              status: 'OPEN',
            },
          });
          if (openRow) {
            // Another row may already own this orderId — e.g. created by the upsert
            // fallback below during a prior/overlapping sync window. A plain update
            // here would otherwise violate the (account_id, order_id) unique
            // constraint, so merge into openRow instead of updating blindly.
            const conflicting = await this.prisma.position.findUnique({
              where: { accountId_orderId: { accountId: account.id, orderId: rec.orderId } },
            });
            if (conflicting && conflicting.id !== openRow.id) {
              await this.prisma.$transaction([
                this.prisma.positionNote.updateMany({
                  where: { positionId: conflicting.id },
                  data: { positionId: openRow.id },
                }),
                this.prisma.position.delete({ where: { id: conflicting.id } }),
                this.prisma.position.update({ where: { id: openRow.id }, data }),
              ]);
            } else {
              await this.prisma.position.update({ where: { id: openRow.id }, data });
            }
            continue;
          }

          // No tracked open row (e.g. backfill of history that predates open-position
          // tracking, or the open-sync hasn't run yet) — fall back to upserting by orderId.
          await this.prisma.position.upsert({
            where: { accountId_orderId: { accountId: account.id, orderId: rec.orderId } },
            create: { accountId: account.id, ...data },
            update: data,
          });
        }
        cursor = page.nextPageCursor || undefined;
      } while (cursor);

      // Advance the cursor after every finished window so an interrupted backfill resumes
      // where it stopped instead of starting over.
      await this.prisma.exchangeAccount.update({
        where: { id: account.id },
        data: { closedPnlSyncedTo: window.to },
      });
    }
  }

  private async syncExecutions(account: ExchangeAccount, creds: BybitCredentials, now: Date) {
    for (const window of this.windows(account.executionsSyncedTo, account.syncFrom, now)) {
      // One shared cursor field covers both categories: the window only advances after
      // every category has been fully paged through.
      for (const category of EXECUTION_CATEGORIES) {
        let cursor: string | undefined;
        do {
          const page = await this.bybit.getExecutions(creds, {
            category,
            startTime: window.from.getTime(),
            endTime: window.to.getTime(),
            cursor,
          });
          for (const rec of page.list) {
            const data = {
              userId: account.userId,
              orderId: rec.orderId,
              symbol: rec.symbol,
              category,
              side: rec.side,
              execType: rec.execType || 'Trade',
              price: rec.execPrice,
              qty: rec.execQty,
              fee: rec.execFee || 0,
              feeCurrency: rec.feeCurrency ?? null,
              execTime: new Date(Number(rec.execTime)),
              raw: rec as Prisma.InputJsonValue,
            };
            await this.prisma.tradeExecution.upsert({
              where: { accountId_execId: { accountId: account.id, execId: rec.execId } },
              create: { accountId: account.id, execId: rec.execId, ...data },
              update: data,
            });
          }
          cursor = page.nextPageCursor || undefined;
        } while (cursor);
      }

      await this.prisma.exchangeAccount.update({
        where: { id: account.id },
        data: { executionsSyncedTo: window.to },
      });
    }
  }

  // Bybit reports no realized PnL for spot and no live "position" endpoint either (spot holdings
  // are just a balance) — both closed round trips and the currently open remainder are derived
  // from the fills by LIFO matching (see spot-lifo.util for why LIFO over FIFO), one row per BUY
  // fill (not merged per symbol) so each purchase is its own diary entry. Recomputed from the
  // full fill history on every sync, stateless and idempotent: every row has a deterministic
  // orderId, so re-runs upsert in place.
  private async rebuildSpotPositions(account: ExchangeAccount) {
    const fills = await this.prisma.tradeExecution.findMany({
      where: { accountId: account.id, category: 'spot' },
      orderBy: [{ execTime: 'asc' }, { createdAt: 'asc' }],
    });
    if (!fills.length) return;

    const { closed, open } = computeSpotPositions(
      fills.map((f) => ({
        execId: f.execId,
        symbol: f.symbol,
        side: f.side,
        price: Number(f.price),
        qty: Number(f.qty),
        fee: Number(f.fee),
        feeCurrency: f.feeCurrency,
        execTime: f.execTime,
      })),
    );

    for (const slice of closed) {
      const data = {
        userId: account.userId,
        symbol: slice.symbol,
        category: 'spot',
        status: 'CLOSED' as const,
        // Spot round trips are always long: bought first, sold later — Sell closes a long.
        side: 'Sell',
        qty: slice.qty,
        avgEntryPrice: slice.avgEntryPrice,
        avgExitPrice: slice.avgExitPrice,
        closedPnl: slice.closedPnl,
        openedAt: slice.openedAt,
        closedAt: slice.closedAt,
      };
      // A slice that fully drains its lot IS that lot's row, now closed — same orderId as when
      // it was open, so notes attached while open survive. A slice that only partially drains
      // its lot (the lot stays open, shrunk, below) gets its own separate historical row.
      const orderId = slice.closesLot ? `spot-open:${slice.lotKey}` : slice.dedupeKey;
      await this.prisma.position.upsert({
        where: { accountId_orderId: { accountId: account.id, orderId } },
        create: { accountId: account.id, orderId, ...data },
        update: data,
      });
    }

    // One row per still-unsold buy lot — each purchase is its own open diary entry. Exit fields
    // are explicitly nulled: if this same lotKey was CLOSED on a previous run (e.g. the FIFO→LIFO
    // switch reshuffled which lot a sell drains), the row must not keep stale avgExitPrice/
    // closedPnl/closedAt sitting alongside a freshly-flipped OPEN status.
    for (const lot of open) {
      const orderId = `spot-open:${lot.lotKey}`;
      const data = {
        userId: account.userId,
        symbol: lot.symbol,
        category: 'spot',
        status: 'OPEN' as const,
        side: 'Sell',
        qty: lot.qty,
        avgEntryPrice: lot.avgEntryPrice,
        avgExitPrice: null,
        closedPnl: null,
        closedAt: null,
        openedAt: lot.openedAt,
      };
      await this.prisma.position.upsert({
        where: { accountId_orderId: { accountId: account.id, orderId } },
        create: { accountId: account.id, orderId, ...data },
        update: data,
      });
    }
  }

  // Fetches Bybit's live open linear positions and keeps one Position row per (account, symbol)
  // in sync with them — creating a fresh OPEN row for a newly opened position, or updating the
  // existing one (qty/avgEntryPrice/leverage move as the position is added to or partially
  // closed). Spot has no equivalent "position" concept on Bybit, so this only covers linear.
  private async syncOpenPositions(account: ExchangeAccount, creds: BybitCredentials) {
    let cursor: string | undefined;
    do {
      const page = await this.bybit.getOpenPositions(creds, {
        category: PNL_CATEGORY,
        settleCoin: 'USDT',
        cursor,
      });
      for (const rec of page.list) {
        if (Number(rec.size) <= 0) continue; // Bybit lists flat/zero-size slots too

        const data = {
          userId: account.userId,
          category: PNL_CATEGORY,
          status: 'OPEN' as const,
          // Flip: Bybit reports the position's own direction here, but Position.side is always
          // the side that closes it (see side.util.ts).
          side: flipSide(rec.side),
          qty: rec.size,
          avgEntryPrice: rec.avgPrice,
          leverage: rec.leverage || null,
          // openTime is when the current (non-zero) position actually started; createdTime is the
          // position slot's original creation and can be much older if the symbol was never fully
          // flat since then (see BybitPositionRecord).
          openedAt: new Date(Number(rec.openTime || rec.createdTime)),
          takeProfitPrice: rec.takeProfit || null,
          stopLossPrice: rec.stopLoss || null,
          raw: rec as Prisma.InputJsonValue,
        };

        const existing = await this.prisma.position.findFirst({
          where: {
            accountId: account.id,
            symbol: rec.symbol,
            category: PNL_CATEGORY,
            status: 'OPEN',
          },
        });
        if (existing) {
          await this.prisma.position.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.position.create({
            data: { accountId: account.id, symbol: rec.symbol, ...data },
          });
        }
      }
      cursor = page.nextPageCursor || undefined;
    } while (cursor);
  }

  // Bybit's Closed PnL records carry no open time for linear (derivatives) positions. Derived
  // from the fills' `closedSize` (in `raw`, see linear-fifo.util) — recomputed from the full
  // history on every sync, same idempotent-rebuild pattern as rebuildSpotPositions.
  private async rebuildLinearOpenedAt(account: ExchangeAccount) {
    const [fills, positions] = await Promise.all([
      this.prisma.tradeExecution.findMany({
        where: { accountId: account.id, category: 'linear', execType: { not: 'Funding' } },
        select: { symbol: true, side: true, qty: true, execTime: true, raw: true },
      }),
      this.prisma.position.findMany({
        where: { accountId: account.id, category: 'linear', status: 'CLOSED' },
        select: { id: true, symbol: true, side: true, qty: true, closedAt: true },
      }),
    ]);
    // The status: 'CLOSED' filter above guarantees closedAt, but Prisma's type keeps it nullable.
    const closedPositions = positions.filter(
      (p): p is typeof p & { closedAt: Date } => p.closedAt !== null,
    );
    if (!fills.length || !closedPositions.length) return;

    const openedAtById = deriveLinearOpenedAt(
      fills.map((f) => ({
        symbol: f.symbol,
        side: f.side,
        qty: Number(f.qty),
        closedSize: Number((f.raw as Record<string, unknown> | null)?.closedSize ?? 0),
        execTime: f.execTime,
      })),
      closedPositions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        qty: Number(p.qty),
        closedAt: p.closedAt,
      })),
    );

    await Promise.all(
      closedPositions
        .filter((p) => openedAtById.has(p.id))
        .map((p) =>
          this.prisma.position.update({
            where: { id: p.id },
            data: { openedAt: openedAtById.get(p.id) },
          }),
        ),
    );
  }

  // [from, to] windows of ≤ 7 days covering everything from the cursor (or syncFrom on the first
  // run) up to `now`, with a small overlap behind the cursor.
  private windows(syncedTo: Date | null, syncFrom: Date, now: Date): { from: Date; to: Date }[] {
    let start = syncedTo ? new Date(syncedTo.getTime() - OVERLAP_MS) : syncFrom;
    if (start < syncFrom) start = syncFrom;

    const result: { from: Date; to: Date }[] = [];
    while (start < now) {
      const end = new Date(Math.min(start.getTime() + WINDOW_MS, now.getTime()));
      result.push({ from: start, to: end });
      start = end;
    }
    return result;
  }
}
