import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ExchangeAccount } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BybitClient } from './bybit.client';
import { encryptSecret } from './crypto.util';
import { InvestingSyncService } from './investing-sync.service';
import { TradeCloseNotifierService } from './trade-close-notifier.service';

const KEY = 'c'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const makeAccount = (over: Partial<ExchangeAccount> = {}): ExchangeAccount =>
  ({
    id: 'acc-1',
    userId: 'u1',
    exchange: 'bybit',
    label: '',
    apiKey: encryptSecret('k', KEY),
    apiSecret: encryptSecret('s', KEY),
    status: 'ACTIVE',
    lastError: null,
    syncFrom: new Date(Date.now() - 10 * DAY),
    closedPnlSyncedTo: null,
    executionsSyncedTo: null,
    lastSyncAt: null,
    createdAt: new Date(),
    ...over,
  }) as ExchangeAccount;

const execRecord = (over: Record<string, string> = {}) => ({
  execId: 'e1',
  orderId: 'o1',
  symbol: 'BTCUSDT',
  side: 'Sell',
  execType: 'Trade',
  execPrice: '65000',
  execQty: '0.09',
  execFee: '0.18',
  feeCurrency: 'USDT',
  execTime: '1750000000000',
  ...over,
});

const pnlRecord = (over: Record<string, string> = {}) => ({
  orderId: 'o1',
  symbol: 'BTCUSDT',
  side: 'Sell',
  qty: '0.5',
  avgEntryPrice: '64000',
  avgExitPrice: '65000',
  closedPnl: '500',
  leverage: '10',
  createdTime: '1750000000000',
  updatedTime: '1750000000000',
  ...over,
});

const openPositionRecord = (over: Record<string, string> = {}) => ({
  symbol: 'BTCUSDT',
  side: 'Buy', // position's own direction (long) — the opposite of pnlRecord's closing-side convention
  size: '0.5',
  avgPrice: '64000',
  leverage: '10',
  createdTime: '1750000000000',
  updatedTime: '1750000000000',
  openTime: '1750000000000',
  ...over,
});

describe('InvestingSyncService', () => {
  let service: InvestingSyncService;
  let prisma: {
    exchangeAccount: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    position: {
      upsert: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
    };
    positionNote: { updateMany: jest.Mock };
    tradeExecution: { upsert: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let bybit: { getClosedPnl: jest.Mock; getExecutions: jest.Mock; getOpenPositions: jest.Mock };

  beforeEach(async () => {
    prisma = {
      exchangeAccount: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      position: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      positionNote: { updateMany: jest.fn() },
      tradeExecution: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    bybit = {
      getClosedPnl: jest.fn().mockResolvedValue({ list: [], nextPageCursor: '' }),
      getExecutions: jest.fn().mockResolvedValue({ list: [], nextPageCursor: '' }),
      getOpenPositions: jest.fn().mockResolvedValue({ list: [], nextPageCursor: '' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvestingSyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: BybitClient, useValue: bybit },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(KEY) } },
        { provide: TradeCloseNotifierService, useValue: { notifyNewlyClosed: jest.fn() } },
      ],
    }).compile();

    service = module.get(InvestingSyncService);
  });

  it('walks the range from syncFrom in windows of at most 7 days', async () => {
    await service.syncAccount(makeAccount());

    // 10 days of history → 2 windows (7d + 3d); executions run per category (linear + spot).
    expect(bybit.getClosedPnl).toHaveBeenCalledTimes(2);
    expect(bybit.getExecutions).toHaveBeenCalledTimes(4);
    expect(new Set(bybit.getExecutions.mock.calls.map(([, p]) => p.category))).toEqual(
      new Set(['linear', 'spot']),
    );
    const first = bybit.getClosedPnl.mock.calls[0][1];
    const second = bybit.getClosedPnl.mock.calls[1][1];
    expect(second.startTime).toBe(first.endTime);
    expect(first.endTime - first.startTime).toBe(7 * DAY);
    // Decrypted creds are passed to the client.
    expect(bybit.getClosedPnl.mock.calls[0][0]).toEqual({ apiKey: 'k', apiSecret: 's' });
  });

  it('resumes from the stored cursor instead of re-reading all history', async () => {
    const syncedTo = new Date(Date.now() - DAY);
    await service.syncAccount(makeAccount({ closedPnlSyncedTo: syncedTo }));

    expect(bybit.getClosedPnl).toHaveBeenCalledTimes(1);
    const { startTime } = bybit.getClosedPnl.mock.calls[0][1];
    // Just behind the cursor (1 min overlap for boundary records).
    expect(startTime).toBe(syncedTo.getTime() - 60_000);
  });

  it('upserts closed positions by (accountId, orderId) and advances the cursor', async () => {
    bybit.getClosedPnl
      .mockResolvedValueOnce({ list: [pnlRecord()], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'o1' } },
        create: expect.objectContaining({ symbol: 'BTCUSDT', closedPnl: '500', userId: 'u1' }),
      }),
    );
    const cursorUpdates = prisma.exchangeAccount.update.mock.calls.filter(
      ([arg]) => arg.data.closedPnlSyncedTo,
    );
    expect(cursorUpdates).toHaveLength(2); // one per finished window
  });

  it('follows nextPageCursor within a window', async () => {
    bybit.getClosedPnl
      .mockResolvedValueOnce({ list: [pnlRecord()], nextPageCursor: 'page2' })
      .mockResolvedValueOnce({ list: [pnlRecord({ orderId: 'o2' })], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount({ syncFrom: new Date(Date.now() - DAY) }));

    expect(bybit.getClosedPnl).toHaveBeenCalledTimes(2);
    expect(bybit.getClosedPnl.mock.calls[1][1].cursor).toBe('page2');
    expect(prisma.position.upsert).toHaveBeenCalledTimes(2);
  });

  it('flips a tracked OPEN row to CLOSED in place instead of creating a new row', async () => {
    prisma.position.findFirst.mockResolvedValue({ id: 'open-row-1' });
    bybit.getClosedPnl
      .mockResolvedValueOnce({ list: [pnlRecord()], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'open-row-1' },
      data: expect.objectContaining({ status: 'CLOSED', orderId: 'o1', closedPnl: '500' }),
    });
    expect(prisma.position.upsert).not.toHaveBeenCalled();
  });

  it('merges into the OPEN row instead of violating the (account_id, order_id) unique constraint when another row already owns that orderId', async () => {
    prisma.position.findFirst.mockResolvedValue({ id: 'open-row-1' });
    prisma.position.findUnique.mockResolvedValue({ id: 'stale-row-1' });
    bybit.getClosedPnl
      .mockResolvedValueOnce({ list: [pnlRecord()], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.positionNote.updateMany).toHaveBeenCalledWith({
      where: { positionId: 'stale-row-1' },
      data: { positionId: 'open-row-1' },
    });
    expect(prisma.position.delete).toHaveBeenCalledWith({ where: { id: 'stale-row-1' } });
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'open-row-1' },
      data: expect.objectContaining({ status: 'CLOSED', orderId: 'o1', closedPnl: '500' }),
    });
  });

  it('updates the OPEN row directly when it already owns the orderId (no self-conflict)', async () => {
    prisma.position.findFirst.mockResolvedValue({ id: 'open-row-1' });
    prisma.position.findUnique.mockResolvedValue({ id: 'open-row-1' });
    bybit.getClosedPnl
      .mockResolvedValueOnce({ list: [pnlRecord()], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.position.delete).not.toHaveBeenCalled();
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'open-row-1' },
      data: expect.objectContaining({ status: 'CLOSED', orderId: 'o1', closedPnl: '500' }),
    });
  });

  it("creates an OPEN position from Bybit's live position list", async () => {
    bybit.getOpenPositions.mockResolvedValue({ list: [openPositionRecord()], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(bybit.getOpenPositions).toHaveBeenCalledWith(
      { apiKey: 'k', apiSecret: 's' },
      expect.objectContaining({ category: 'linear', settleCoin: 'USDT' }),
    );
    expect(prisma.position.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'acc-1',
        symbol: 'BTCUSDT',
        category: 'linear',
        status: 'OPEN',
        // Bybit's Buy (long position) flips to the closing-order convention: Sell.
        side: 'Sell',
        qty: '0.5',
        avgEntryPrice: '64000',
      }),
    });
  });

  it('uses openTime rather than createdTime for a freshly (re)opened position', async () => {
    bybit.getOpenPositions.mockResolvedValue({
      list: [openPositionRecord({ createdTime: '1710000000000', openTime: '1750000000000' })],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openedAt: new Date(1750000000000) }),
    });
  });

  it('falls back to createdTime when openTime is absent from the payload', async () => {
    const { openTime: _openTime, ...withoutOpenTime } = openPositionRecord();
    bybit.getOpenPositions.mockResolvedValue({
      list: [withoutOpenTime],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ openedAt: new Date(1750000000000) }),
    });
  });

  it("carries take-profit/stop-loss over from Bybit's live position list", async () => {
    bybit.getOpenPositions.mockResolvedValue({
      list: [openPositionRecord({ takeProfit: '68000', stopLoss: '62000' })],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ takeProfitPrice: '68000', stopLossPrice: '62000' }),
    });
  });

  it('treats an empty take-profit/stop-loss string (Bybit convention for "not set") as null', async () => {
    bybit.getOpenPositions.mockResolvedValue({
      list: [openPositionRecord({ takeProfit: '', stopLoss: '' })],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ takeProfitPrice: null, stopLossPrice: null }),
    });
  });

  it('updates the existing OPEN row for a symbol instead of duplicating it', async () => {
    prisma.position.findFirst.mockResolvedValue({ id: 'open-row-1' });
    bybit.getOpenPositions.mockResolvedValue({
      list: [openPositionRecord({ size: '0.8' })],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'open-row-1' },
      data: expect.objectContaining({ qty: '0.8' }),
    });
    expect(prisma.position.create).not.toHaveBeenCalled();
  });

  it('skips zero-size position slots from the open-positions sync', async () => {
    bybit.getOpenPositions.mockResolvedValue({
      list: [openPositionRecord({ size: '0' })],
      nextPageCursor: '',
    });

    await service.syncAccount(makeAccount());

    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  it('stores execType from the exchange record, defaulting to Trade when absent', async () => {
    bybit.getExecutions
      .mockResolvedValueOnce({ list: [execRecord({ execType: 'Funding' })], nextPageCursor: '' })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.tradeExecution.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ execType: 'Funding' }),
        update: expect.objectContaining({ execType: 'Funding' }),
      }),
    );

    prisma.tradeExecution.upsert.mockClear();
    bybit.getExecutions
      .mockReset()
      .mockResolvedValueOnce({
        list: [execRecord({ execId: 'e2', execType: '' })],
        nextPageCursor: '',
      })
      .mockResolvedValue({ list: [], nextPageCursor: '' });

    await service.syncAccount(makeAccount());

    expect(prisma.tradeExecution.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ execType: 'Trade' }) }),
    );
  });

  it('derives and stores openedAt for linear positions from opening fills after the sync', async () => {
    const openFill = {
      symbol: 'BTCUSDT',
      side: 'Buy',
      qty: 1,
      execTime: new Date('2026-07-01T00:00:00Z'),
      raw: { closedSize: '0' },
    };
    const closedPos = {
      id: 'pos-1',
      symbol: 'BTCUSDT',
      side: 'Sell',
      qty: 1,
      closedAt: new Date('2026-07-02T00:00:00Z'),
    };
    // The same tradeExecution.findMany mock backs both rebuildSpotPositions (category: 'spot')
    // and rebuildLinearOpenedAt (category: 'linear') — branch on the query to keep them apart.
    prisma.tradeExecution.findMany.mockImplementation(
      ({ where }: { where: { category: string } }) =>
        Promise.resolve(where.category === 'linear' ? [openFill] : []),
    );
    prisma.position.findMany.mockResolvedValue([closedPos]);

    await service.syncAccount(makeAccount());

    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'pos-1' },
      data: { openedAt: openFill.execTime },
    });
  });

  it('skips the linear openedAt rebuild when there are no fills or no linear positions', async () => {
    prisma.tradeExecution.findMany.mockResolvedValue([]);
    prisma.position.findMany.mockResolvedValue([]);

    await service.syncAccount(makeAccount());

    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  it('closes a fully-sold lot in place (same orderId whether open or closed), so notes survive', async () => {
    const buy = {
      execId: 'b1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: 100,
      qty: 1,
      fee: 0,
      feeCurrency: null,
      execTime: new Date('2026-07-01T00:00:00Z'),
    };
    const sell = {
      ...buy,
      execId: 's1',
      side: 'Sell',
      price: 150,
      execTime: new Date('2026-07-02T00:00:00Z'),
    };
    prisma.tradeExecution.findMany.mockResolvedValue([buy, sell]);

    await service.syncAccount(makeAccount());

    expect(prisma.tradeExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: 'acc-1', category: 'spot' } }),
    );
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b1' } },
        create: expect.objectContaining({
          category: 'spot',
          status: 'CLOSED',
          side: 'Sell',
          closedPnl: 50,
          openedAt: buy.execTime,
          closedAt: sell.execTime,
        }),
      }),
    );
    // No separate row for the closing sell — it reuses the lot's own orderId.
    expect(prisma.position.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_orderId: { accountId: 'acc-1', orderId: expect.stringContaining('s1') },
        },
      }),
    );
  });

  it('creates one OPEN row per unsold buy, since Bybit has no live spot position endpoint', async () => {
    const buy1 = {
      execId: 'b1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: 100,
      qty: 1,
      fee: 0,
      feeCurrency: null,
      execTime: new Date('2026-07-01T00:00:00Z'),
    };
    const buy2 = { ...buy1, execId: 'b2', price: 200, execTime: new Date('2026-07-05T00:00:00Z') };
    prisma.tradeExecution.findMany.mockResolvedValue([buy1, buy2]);

    await service.syncAccount(makeAccount());

    // Two separate purchases stay two separate open diary entries — not merged/averaged.
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b1' } },
        create: expect.objectContaining({ status: 'OPEN', qty: 1, avgEntryPrice: 100 }),
      }),
    );
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b2' } },
        create: expect.objectContaining({ status: 'OPEN', qty: 1, avgEntryPrice: 200 }),
      }),
    );
  });

  it('shrinks a lot in place on a partial sell, recording the nibble as its own closed row', async () => {
    const buy = {
      execId: 'b1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: 100,
      qty: 2,
      fee: 0,
      feeCurrency: null,
      execTime: new Date('2026-07-01T00:00:00Z'),
    };
    const partialSell = {
      ...buy,
      execId: 's1',
      side: 'Sell',
      qty: 0.5,
      price: 110,
      execTime: new Date('2026-07-02T00:00:00Z'),
    };
    prisma.tradeExecution.findMany.mockResolvedValue([buy, partialSell]);

    await service.syncAccount(makeAccount());

    // The nibble is its own historical row (the lot itself isn't closed) — dedupe key combines
    // the lot and the sell.
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot:b1:s1' } },
        create: expect.objectContaining({ status: 'CLOSED', qty: 0.5, closedPnl: 5 }),
      }),
    );
    // The lot's own row stays open, shrunk to what's left, same orderId as before.
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b1' } },
        update: expect.objectContaining({ status: 'OPEN', qty: 1.5 }),
      }),
    );
  });

  it('closes the newest lot first on a sell spanning multiple lots (LIFO)', async () => {
    const buy1 = {
      execId: 'b1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: 100,
      qty: 1,
      fee: 0,
      feeCurrency: null,
      execTime: new Date('2026-07-01T00:00:00Z'),
    };
    const buy2 = { ...buy1, execId: 'b2', price: 200, execTime: new Date('2026-07-05T00:00:00Z') };
    const sell = {
      ...buy1,
      execId: 's1',
      side: 'Sell',
      qty: 1,
      price: 300,
      execTime: new Date('2026-07-10T00:00:00Z'),
    };
    prisma.tradeExecution.findMany.mockResolvedValue([buy1, buy2, sell]);

    await service.syncAccount(makeAccount());

    // buy2 (newer, $200) is what the sell drains and closes — not buy1 ($100), the older one.
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b2' } },
        update: expect.objectContaining({ status: 'CLOSED', closedPnl: 100 }),
      }),
    );
    // buy1 is untouched, still open at its original quantity.
    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b1' } },
        update: expect.objectContaining({ status: 'OPEN', qty: 1, avgExitPrice: null }),
      }),
    );
  });

  it("clears a lot's stale exit fields when a resync flips it back from CLOSED to OPEN", async () => {
    // Simulates the FIFO→LIFO switch: this lot was closed on a previous run, but this run's
    // fills only cover a buy — nothing here closes it, so it must come back fully OPEN, not
    // OPEN-with-leftover avgExitPrice/closedPnl/closedAt from before.
    const buy = {
      execId: 'b1',
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: 100,
      qty: 1,
      fee: 0,
      feeCurrency: null,
      execTime: new Date('2026-07-01T00:00:00Z'),
    };
    prisma.tradeExecution.findMany.mockResolvedValue([buy]);

    await service.syncAccount(makeAccount());

    expect(prisma.position.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_orderId: { accountId: 'acc-1', orderId: 'spot-open:b1' } },
        update: expect.objectContaining({
          status: 'OPEN',
          avgExitPrice: null,
          closedPnl: null,
          closedAt: null,
        }),
      }),
    );
  });

  it('marks the account ERROR with the reason when the sync fails, and rethrows', async () => {
    bybit.getClosedPnl.mockRejectedValue(new Error('rate limited'));

    await expect(service.syncAccount(makeAccount())).rejects.toThrow('rate limited');
    expect(prisma.exchangeAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      data: { status: 'ERROR', lastError: expect.stringContaining('rate limited') },
    });
  });

  it('marks the account healthy after a successful sync', async () => {
    await service.syncAccount(makeAccount({ status: 'ERROR', lastError: 'old error' }));

    expect(prisma.exchangeAccount.update).toHaveBeenLastCalledWith({
      where: { id: 'acc-1' },
      data: { lastSyncAt: expect.any(Date), status: 'ACTIVE', lastError: null },
    });
  });

  it('skips everything when ENCRYPTION_KEY is not configured', async () => {
    const module = await Test.createTestingModule({
      providers: [
        InvestingSyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: BybitClient, useValue: bybit },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: TradeCloseNotifierService, useValue: { notifyNewlyClosed: jest.fn() } },
      ],
    }).compile();

    await module.get(InvestingSyncService).syncAll();
    expect(prisma.exchangeAccount.findMany).not.toHaveBeenCalled();
  });
});
