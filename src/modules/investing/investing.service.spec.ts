import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { BybitClient } from './bybit.client';
import { decryptSecret } from './crypto.util';
import { InvestingService } from './investing.service';
import { InvestingSyncService } from './investing-sync.service';
import { PriceService } from './price.service';

const KEY = 'd'.repeat(64);

describe('InvestingService', () => {
  let service: InvestingService;
  let prisma: {
    exchangeAccount: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    position: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    positionNote: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findFirst: jest.Mock;
    };
    tradeExecution: { findMany: jest.Mock; count: jest.Mock; aggregate: jest.Mock };
    holding: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let bybit: { validateKey: jest.Mock };
  let sync: { syncAccount: jest.Mock; syncAccountById: jest.Mock };
  let prices: { getUsdPrices: jest.Mock; getLinearPrices: jest.Mock; priceOf: jest.Mock };
  let configGet: jest.Mock;

  beforeEach(async () => {
    prisma = {
      exchangeAccount: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      position: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
      positionNote: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findFirst: jest.fn(),
      },
      tradeExecution: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
      holding: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    bybit = { validateKey: jest.fn().mockResolvedValue({ readOnly: true }) };
    sync = { syncAccount: jest.fn(), syncAccountById: jest.fn().mockResolvedValue(undefined) };
    prices = { getUsdPrices: jest.fn(), getLinearPrices: jest.fn(), priceOf: jest.fn() };
    configGet = jest.fn().mockReturnValue(KEY);

    const module = await Test.createTestingModule({
      providers: [
        InvestingService,
        { provide: PrismaService, useValue: prisma },
        { provide: BybitClient, useValue: bybit },
        { provide: InvestingSyncService, useValue: sync },
        { provide: PriceService, useValue: prices },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(InvestingService);
  });

  describe('addAccount', () => {
    const dto = { apiKey: 'plain-key', apiSecret: 'plain-secret', label: 'Main account' };

    it('validates the key, stores it encrypted and backfills as far back as Bybit allows', async () => {
      prisma.exchangeAccount.create.mockImplementation(({ data }: { data: never }) =>
        Promise.resolve({ id: 'acc-1', ...(data as object) }),
      );

      const before = Date.now();
      const result = await service.addAccount('u1', dto);
      const after = Date.now();

      expect(bybit.validateKey).toHaveBeenCalledWith({
        apiKey: dto.apiKey,
        apiSecret: dto.apiSecret,
      });
      const { data } = prisma.exchangeAccount.create.mock.calls[0][0];
      // ~729 days back from "now" — not tied to the user's registration date anymore, and just
      // under Bybit's 2-year hard limit on startTime.
      const MAX_HISTORY_MS = 729 * 24 * 60 * 60 * 1000;
      expect(data.syncFrom.getTime()).toBeGreaterThanOrEqual(before - MAX_HISTORY_MS);
      expect(data.syncFrom.getTime()).toBeLessThanOrEqual(after - MAX_HISTORY_MS);
      expect(data.label).toBe('Main account');
      // Stored encrypted, not in plaintext — but decryptable with the master key.
      expect(data.apiKey).not.toContain('plain-key');
      expect(decryptSecret(data.apiKey, KEY)).toBe('plain-key');
      expect(decryptSecret(data.apiSecret, KEY)).toBe('plain-secret');
      // The initial backfill is kicked off in the background.
      expect(sync.syncAccountById).toHaveBeenCalledWith('acc-1');
      // The response exposes a mask and the readOnly flag, never the secret.
      expect(result.readOnly).toBe(true);
      expect(result.apiKeyMasked).toBe('••••-key');
      expect(result).not.toHaveProperty('apiSecret');
    });

    it('rejects a key Bybit does not accept', async () => {
      bybit.validateKey.mockRejectedValue(new Error('invalid key'));
      await expect(service.addAccount('u1', dto)).rejects.toThrow(BadRequestException);
      expect(prisma.exchangeAccount.create).not.toHaveBeenCalled();
    });

    it('rejects a valid key that is not read-only', async () => {
      bybit.validateKey.mockResolvedValue({ readOnly: false });
      await expect(service.addAccount('u1', dto)).rejects.toThrow(/read-only/);
      expect(prisma.exchangeAccount.create).not.toHaveBeenCalled();
    });

    it('fails clearly when ENCRYPTION_KEY is not configured', async () => {
      configGet.mockReturnValue(undefined);
      await expect(service.addAccount('u1', dto)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('removeAccount', () => {
    it('deletes an owned account', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      await expect(service.removeAccount('u1', 'acc-1')).resolves.toEqual({ deleted: true });
      expect(prisma.exchangeAccount.delete).toHaveBeenCalledWith({ where: { id: 'acc-1' } });
    });

    it('404s on a foreign or missing account', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue(null);
      await expect(service.removeAccount('u1', 'other')).rejects.toThrow(NotFoundException);
      expect(prisma.exchangeAccount.delete).not.toHaveBeenCalled();
    });
  });

  describe('renameAccount', () => {
    it('updates the label of an owned account', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      prisma.exchangeAccount.update.mockResolvedValue({
        id: 'acc-1',
        exchange: 'bybit',
        label: 'Futures acc',
        apiKey: 'irrelevant-here',
      });

      const result = await service.renameAccount('u1', 'acc-1', { label: 'Futures acc' });

      expect(prisma.exchangeAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { label: 'Futures acc' },
      });
      expect(result.label).toBe('Futures acc');
    });

    it('404s on a foreign or missing account', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue(null);
      await expect(service.renameAccount('u1', 'other', { label: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.exchangeAccount.update).not.toHaveBeenCalled();
    });
  });

  describe('syncNow', () => {
    it('returns the refreshed account on a successful sync', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      sync.syncAccount.mockResolvedValue(undefined);
      prisma.exchangeAccount.findUniqueOrThrow.mockResolvedValue({
        id: 'acc-1',
        exchange: 'bybit',
        label: 'Main',
        apiKey: 'irrelevant-here',
        status: 'ACTIVE',
        lastError: null,
      });

      const result = await service.syncNow('u1', 'acc-1');

      expect(sync.syncAccount).toHaveBeenCalledWith({ id: 'acc-1' });
      expect(result.status).toBe('ACTIVE');
    });

    it('surfaces a sync failure (e.g. Bybit IP-whitelist rejection) as 502, not a bare 500', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      sync.syncAccount.mockRejectedValue(
        new Error(
          "Bybit error 10010: Unmatched IP, please check your API key's bound IP addresses.",
        ),
      );

      await expect(service.syncNow('u1', 'acc-1')).rejects.toThrow(BadGatewayException);
      await expect(service.syncNow('u1', 'acc-1')).rejects.toThrow(/Unmatched IP/);
      expect(prisma.exchangeAccount.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('404s on a foreign or missing account', async () => {
      prisma.exchangeAccount.findFirst.mockResolvedValue(null);
      await expect(service.syncNow('u1', 'other')).rejects.toThrow(NotFoundException);
      expect(sync.syncAccount).not.toHaveBeenCalled();
    });
  });

  describe('getPositions', () => {
    it('filters by symbol (uppercased) and date range, returns items with total', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'manual',
          accountId: null,
          qty: 1,
          avgEntryPrice: 65000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(42);
      const from = new Date('2026-07-01');

      const result = await service.getPositions('u1', { symbol: 'btcusdt', from, limit: 10 });

      expect(prisma.position.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          symbol: { contains: 'BTCUSDT' },
          openedAt: { gte: from, lte: undefined },
        },
        orderBy: [{ openedAt: 'desc' }, { closedAt: 'desc' }],
        include: { notes: { orderBy: { createdAt: 'asc' } } },
        take: 10,
        skip: 0,
      });
      // Manual entries have no leverage (→ 1x) and no fee lookup (no accountId/openedAt).
      expect(result.total).toBe(42);
      expect(result.items[0]).toMatchObject({ id: 'p1', entryVolumeUsd: 65000, totalFeeUsd: null });
    });

    it('filters by openedAt range so still-open trades outside it stay hidden, unlike closedAt', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);
      const from = new Date('2026-07-20');
      const to = new Date('2026-07-21');

      await service.getPositions('u1', { from, to });

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        openedAt: { gte: from, lte: to },
      });
    });

    it('applies no date filter when from/to are omitted', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositions('u1', {});

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1' });
    });

    it('filters by status alone', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositions('u1', { status: 'OPEN' });

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        status: 'OPEN',
      });
    });

    it('filters by category', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositions('u1', { category: 'spot' });

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        category: 'spot',
      });
    });

    it('combines status=CLOSED with an openedAt date range', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);
      const from = new Date('2026-07-01');

      await service.getPositions('u1', { status: 'CLOSED', from });

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        status: 'CLOSED',
        openedAt: { gte: from, lte: undefined },
      });
    });

    it('filters by pnl sign: CLOSED via closedPnl column, OPEN via live-priced ids', async () => {
      // First findMany call is openIdsMatchingPnlSign's own lookup (status forced OPEN);
      // the second is the real paginated query.
      prisma.position.findMany
        .mockResolvedValueOnce([
          {
            id: 'o1',
            symbol: 'BTCUSDT',
            category: 'spot',
            side: 'Sell',
            qty: 1,
            avgEntryPrice: 100,
          },
          {
            id: 'o2',
            symbol: 'ETHUSDT',
            category: 'linear',
            side: 'Buy',
            qty: 1,
            avgEntryPrice: 100,
          },
        ])
        .mockResolvedValueOnce([]);
      prisma.position.count.mockResolvedValue(0);
      prices.getUsdPrices.mockResolvedValue(new Map([['BTCUSDT', 150]]));
      prices.getLinearPrices.mockResolvedValue(new Map([['ETHUSDT', 150]]));

      await service.getPositions('u1', { pnl: 'positive' });

      // o1 is long (side Sell) and priced up → +50, matches "positive"; o2 is short (side Buy)
      // and priced up → -50, excluded.
      expect(prisma.position.findMany).toHaveBeenNthCalledWith(1, {
        where: { userId: 'u1', status: 'OPEN' },
        select: {
          id: true,
          symbol: true,
          category: true,
          side: true,
          qty: true,
          avgEntryPrice: true,
        },
      });
      expect(prisma.position.findMany.mock.calls[1][0].where).toEqual({
        AND: [
          { userId: 'u1' },
          { OR: [{ status: 'CLOSED', closedPnl: { gt: 0 } }, { id: { in: ['o1'] } }] },
        ],
      });
    });

    it('skips the live-priced open lookup when status=CLOSED already excludes OPEN rows', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositions('u1', { status: 'CLOSED', pnl: 'negative' });

      expect(prisma.position.findMany).toHaveBeenCalledTimes(1);
      expect(prices.getUsdPrices).not.toHaveBeenCalled();
      expect(prices.getLinearPrices).not.toHaveBeenCalled();
      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        AND: [
          { userId: 'u1', status: 'CLOSED' },
          { OR: [{ status: 'CLOSED', closedPnl: { lt: 0 } }] },
        ],
      });
    });

    it('divides entry volume by leverage and sums fees over the position window for synced trades', async () => {
      const openedAt = new Date('2026-07-01T00:00:00Z');
      const closedAt = new Date('2026-07-02T00:00:00Z');
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          symbol: 'BTCUSDT',
          category: 'linear',
          qty: 1,
          avgEntryPrice: 65000,
          leverage: 10,
          openedAt,
          closedAt,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prisma.tradeExecution.aggregate.mockResolvedValue({ _sum: { fee: -12.345 } });

      const result = await service.getPositions('u1', {});

      expect(prisma.tradeExecution.aggregate).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-1',
          symbol: 'BTCUSDT',
          category: 'linear',
          execTime: { gte: openedAt, lte: closedAt },
        },
        _sum: { fee: true },
      });
      expect(result.items[0]).toMatchObject({ entryVolumeUsd: 6500, totalFeeUsd: -12.34 });
    });

    it('leaves totalFeeUsd null for a synced position with no known open time', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          symbol: 'BTCUSDT',
          category: 'linear',
          qty: 1,
          avgEntryPrice: 65000,
          leverage: 10,
          openedAt: null,
          closedAt: new Date(),
        },
      ]);
      prisma.position.count.mockResolvedValue(1);

      const result = await service.getPositions('u1', {});

      expect(prisma.tradeExecution.aggregate).not.toHaveBeenCalled();
      expect(result.items[0].totalFeeUsd).toBeNull();
    });

    it('caps the page size', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositions('u1', { limit: 10_000 });

      expect(prisma.position.findMany.mock.calls[0][0].take).toBe(200);
    });

    it('prices an open linear position directly by symbol from the linear feed (long) and computes unrealized PnL', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          status: 'OPEN',
          symbol: 'BTCUSDT',
          category: 'linear',
          side: 'Sell', // closing-side convention: Sell closes a long
          qty: 1,
          avgEntryPrice: 60000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prices.getLinearPrices.mockResolvedValue(new Map([['BTCUSDT', 65000]]));

      const result = await service.getPositions('u1', {});

      // Direct symbol match on the linear feed — no bare-asset derivation, no priceOf involved.
      expect(prices.getUsdPrices).not.toHaveBeenCalled();
      expect(prices.priceOf).not.toHaveBeenCalled();
      expect(result.items[0]).toMatchObject({ currentPrice: 65000, unrealizedPnl: 5000 });
    });

    it('prices an open short linear position with the opposite PnL sign', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          status: 'OPEN',
          symbol: 'BTCUSDT',
          category: 'linear',
          side: 'Buy', // closing-side convention: Buy closes a short
          qty: 1,
          avgEntryPrice: 60000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prices.getLinearPrices.mockResolvedValue(new Map([['BTCUSDT', 65000]]));

      const result = await service.getPositions('u1', {});

      expect(result.items[0]).toMatchObject({ currentPrice: 65000, unrealizedPnl: -5000 });
    });

    it('prices a multiplier-ticker linear symbol (e.g. SHIB1000USDT) correctly by matching it as-is, not by deriving a bare asset', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          status: 'OPEN',
          symbol: 'SHIB1000USDT',
          category: 'linear',
          side: 'Sell',
          qty: 3565,
          avgEntryPrice: 0.005738,
          leverage: 2,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prices.getLinearPrices.mockResolvedValue(new Map([['SHIB1000USDT', 0.00654]]));

      const result = await service.getPositions('u1', {});

      expect(result.items[0].currentPrice).toBe(0.00654);
      expect(result.items[0].unrealizedPnl).not.toBeNull();
    });

    it('prices an open spot position directly by symbol from the spot feed', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          status: 'OPEN',
          symbol: 'BTCUSDT',
          category: 'spot',
          side: 'Sell',
          qty: 1,
          avgEntryPrice: 60000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prices.getUsdPrices.mockResolvedValue(new Map([['BTCUSDT', 65000]]));

      const result = await service.getPositions('u1', {});

      expect(prices.getLinearPrices).not.toHaveBeenCalled();
      expect(prices.priceOf).not.toHaveBeenCalled();
      expect(result.items[0]).toMatchObject({ currentPrice: 65000, unrealizedPnl: 5000 });
    });

    it('prices an open manual position by bare asset ticker (still via priceOf, since the symbol is user-typed)', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'manual',
          accountId: null,
          status: 'OPEN',
          symbol: 'BTCUSDT',
          category: 'manual',
          side: 'Sell',
          qty: 1,
          avgEntryPrice: 60000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      const priceMap = new Map<string, number>();
      prices.getUsdPrices.mockResolvedValue(priceMap);
      prices.priceOf.mockImplementation((asset: string) => (asset === 'BTC' ? 65000 : null));

      const result = await service.getPositions('u1', {});

      expect(prices.priceOf).toHaveBeenCalledWith('BTC', priceMap);
      expect(result.items[0]).toMatchObject({ currentPrice: 65000, unrealizedPnl: 5000 });
    });

    it('leaves currentPrice/unrealizedPnl null for closed positions, and skips price fetches entirely', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'bybit',
          accountId: 'acc-1',
          status: 'CLOSED',
          symbol: 'BTCUSDT',
          category: 'linear',
          side: 'Sell',
          qty: 1,
          avgEntryPrice: 60000,
          avgExitPrice: 65000,
          closedPnl: 5000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);

      const result = await service.getPositions('u1', {});

      expect(prices.getUsdPrices).not.toHaveBeenCalled();
      expect(prices.getLinearPrices).not.toHaveBeenCalled();
      expect(result.items[0]).toMatchObject({ currentPrice: null, unrealizedPnl: null });
    });

    it('leaves currentPrice/unrealizedPnl null when the symbol has no matching ticker or prices are unavailable', async () => {
      prisma.position.findMany.mockResolvedValue([
        {
          id: 'p1',
          source: 'manual',
          accountId: null,
          status: 'OPEN',
          symbol: 'MYCOIN',
          category: 'manual',
          side: 'Sell',
          qty: 1,
          avgEntryPrice: 60000,
          leverage: null,
        },
      ]);
      prisma.position.count.mockResolvedValue(1);
      prices.getUsdPrices.mockResolvedValue(new Map());
      prices.priceOf.mockReturnValue(null);

      const result = await service.getPositions('u1', {});

      expect(result.items[0]).toMatchObject({ currentPrice: null, unrealizedPnl: null });
    });
  });

  describe('getPositionSymbols', () => {
    it('returns distinct traded symbols, alphabetical, regardless of status/category/account', async () => {
      prisma.position.findMany.mockResolvedValue([
        { symbol: 'BTCUSDT' },
        { symbol: 'ETHUSDT' },
        { symbol: 'SHIB1000USDT' },
      ]);

      const result = await service.getPositionSymbols('u1');

      expect(prisma.position.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        select: { symbol: true },
        distinct: ['symbol'],
        orderBy: { symbol: 'asc' },
      });
      expect(result).toEqual(['BTCUSDT', 'ETHUSDT', 'SHIB1000USDT']);
    });
  });

  describe('getPositionsSummary', () => {
    it('sums closedPnl and the win/loss/breakeven split across the full filtered history', async () => {
      prisma.position.aggregate.mockResolvedValue({ _sum: { closedPnl: 4820.555 } });
      prisma.position.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: 3 },
        { status: 'CLOSED', _count: 142 },
      ]);
      prisma.position.count.mockResolvedValueOnce(88).mockResolvedValueOnce(51);

      const result = await service.getPositionsSummary('u1', {});

      expect(prisma.position.aggregate).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        _sum: { closedPnl: true },
      });
      expect(prisma.position.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { userId: 'u1' },
        _count: true,
      });
      expect(prisma.position.count).toHaveBeenNthCalledWith(1, {
        where: { userId: 'u1', status: 'CLOSED', closedPnl: { gt: 0 } },
      });
      expect(prisma.position.count).toHaveBeenNthCalledWith(2, {
        where: { userId: 'u1', status: 'CLOSED', closedPnl: { lt: 0 } },
      });
      expect(result).toEqual({
        totalPnl: 4820.56,
        openCount: 3,
        closedCount: 142,
        winCount: 88,
        lossCount: 51,
        breakevenCount: 3, // 142 - 88 - 51
      });
    });

    it('reuses the same filter (symbol/date/status/category) as getPositions', async () => {
      prisma.position.aggregate.mockResolvedValue({ _sum: { closedPnl: 100 } });
      prisma.position.groupBy.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);
      const from = new Date('2026-07-01');

      await service.getPositionsSummary('u1', {
        symbol: 'btcusdt',
        status: 'CLOSED',
        category: 'linear',
        from,
      });

      const expectedWhere = {
        userId: 'u1',
        symbol: { contains: 'BTCUSDT' },
        status: 'CLOSED',
        category: 'linear',
        openedAt: { gte: from, lte: undefined },
      };
      expect(prisma.position.aggregate).toHaveBeenCalledWith({
        where: expectedWhere,
        _sum: { closedPnl: true },
      });
      expect(prisma.position.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: expectedWhere,
        _count: true,
      });
      expect(prisma.position.count).toHaveBeenNthCalledWith(1, {
        where: { ...expectedWhere, status: 'CLOSED', closedPnl: { gt: 0 } },
      });
    });

    it('applies the pnl filter (status=CLOSED short-circuits the live open lookup)', async () => {
      prisma.position.aggregate.mockResolvedValue({ _sum: { closedPnl: 100 } });
      prisma.position.groupBy.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      await service.getPositionsSummary('u1', { status: 'CLOSED', pnl: 'positive' });

      const expectedWhere = {
        AND: [
          { userId: 'u1', status: 'CLOSED' },
          { OR: [{ status: 'CLOSED', closedPnl: { gt: 0 } }] },
        ],
      };
      expect(prisma.position.aggregate).toHaveBeenCalledWith({
        where: expectedWhere,
        _sum: { closedPnl: true },
      });
      expect(prices.getUsdPrices).not.toHaveBeenCalled();
    });

    it('returns zero counts/pnl when nothing matches', async () => {
      prisma.position.aggregate.mockResolvedValue({ _sum: { closedPnl: null } });
      prisma.position.groupBy.mockResolvedValue([]);
      prisma.position.count.mockResolvedValue(0);

      const result = await service.getPositionsSummary('u1', {});

      expect(result).toEqual({
        totalPnl: 0,
        openCount: 0,
        closedCount: 0,
        winCount: 0,
        lossCount: 0,
        breakevenCount: 0,
      });
    });
  });

  describe('getEquityCurve', () => {
    it('returns closedAt/closedPnl pairs, oldest first, with no take limit', async () => {
      const d1 = new Date('2026-06-01');
      const d2 = new Date('2026-06-15');
      prisma.position.findMany.mockResolvedValue([
        { closedAt: d1, closedPnl: 120.5 },
        { closedAt: d2, closedPnl: -30 },
      ]);

      const result = await service.getEquityCurve('u1', {});

      expect(prisma.position.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', status: 'CLOSED' },
        select: { closedAt: true, closedPnl: true },
        orderBy: { closedAt: 'asc' },
      });
      expect(prisma.position.findMany.mock.calls[0][0].take).toBeUndefined();
      expect(result).toEqual({
        items: [
          { closedAt: d1, closedPnl: 120.5 },
          { closedAt: d2, closedPnl: -30 },
        ],
      });
    });

    it('forces status=CLOSED and applies the same symbol/category/date filters', async () => {
      prisma.position.findMany.mockResolvedValue([]);
      const from = new Date('2026-07-01');

      await service.getEquityCurve('u1', { symbol: 'btcusdt', category: 'linear', from });

      expect(prisma.position.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u1',
        symbol: { contains: 'BTCUSDT' },
        category: 'linear',
        status: 'CLOSED',
        closedAt: { gte: from, lte: undefined },
      });
    });

    it('defaults a null closedPnl to 0', async () => {
      prisma.position.findMany.mockResolvedValue([{ closedAt: new Date(), closedPnl: null }]);

      const result = await service.getEquityCurve('u1', {});

      expect(result.items[0].closedPnl).toBe(0);
    });
  });

  describe('getTrades', () => {
    it('excludes funding settlements from items/total and rolls them into a separate summary', async () => {
      prisma.tradeExecution.findMany.mockResolvedValue([{ id: 't1' }]);
      prisma.tradeExecution.count.mockResolvedValue(3);
      prisma.tradeExecution.aggregate.mockResolvedValue({ _sum: { fee: -0.42 }, _count: 27 });

      const result = await service.getTrades('u1', { symbol: 'BTCUSDT' });

      expect(prisma.tradeExecution.findMany.mock.calls[0][0].where).toMatchObject({
        execType: { not: 'Funding' },
      });
      expect(prisma.tradeExecution.count.mock.calls[0][0].where).toMatchObject({
        execType: { not: 'Funding' },
      });
      expect(prisma.tradeExecution.aggregate).toHaveBeenCalledWith({
        where: expect.objectContaining({ execType: 'Funding' }),
        _sum: { fee: true },
        _count: true,
      });
      expect(result).toEqual({
        items: [{ id: 't1' }],
        total: 3,
        funding: { totalFee: -0.42, count: 27 },
      });
    });

    it('defaults funding.totalFee to 0 when there are no funding rows', async () => {
      prisma.tradeExecution.findMany.mockResolvedValue([]);
      prisma.tradeExecution.count.mockResolvedValue(0);
      prisma.tradeExecution.aggregate.mockResolvedValue({ _sum: { fee: null }, _count: 0 });

      const result = await service.getTrades('u1', {});

      expect(result.funding).toEqual({ totalFee: 0, count: 0 });
    });
  });

  describe('manual positions', () => {
    it('creates a long with computed PnL and the exchange side convention', async () => {
      prisma.position.create.mockResolvedValue({ id: 'p1' });

      await service.addManualPosition('u1', {
        symbol: 'btcusdt',
        direction: 'long',
        qty: 0.5,
        entryPrice: 64000,
        exitPrice: 65200,
        closedAt: new Date('2026-07-12T15:30:00Z'),
        venue: 'MEXC',
      });

      const { data } = prisma.position.create.mock.calls[0][0];
      expect(data).toMatchObject({
        userId: 'u1',
        source: 'manual',
        symbol: 'BTCUSDT',
        side: 'Sell', // a long is closed by a Sell — same convention as synced rows
        closedPnl: 600, // (65200 - 64000) * 0.5
        raw: { venue: 'MEXC' },
      });
    });

    it('computes short PnL with the inverted sign and prefers an explicit value', async () => {
      prisma.position.create.mockResolvedValue({});

      await service.addManualPosition('u1', {
        symbol: 'ETHUSDT',
        direction: 'short',
        qty: 2,
        entryPrice: 3500,
        exitPrice: 3400,
        closedAt: new Date(),
      });
      expect(prisma.position.create.mock.calls[0][0].data.closedPnl).toBe(200);

      await service.addManualPosition('u1', {
        symbol: 'ETHUSDT',
        direction: 'short',
        qty: 2,
        entryPrice: 3500,
        exitPrice: 3400,
        closedPnl: 185.5, // fees accounted by the user
        closedAt: new Date(),
      });
      expect(prisma.position.create.mock.calls[1][0].data.closedPnl).toBe(185.5);
    });

    it('stores hand-entered take-profit/stop-loss on create, null when omitted', async () => {
      prisma.position.create.mockResolvedValue({});

      await service.addManualPosition('u1', {
        symbol: 'BTCUSDT',
        direction: 'long',
        qty: 0.5,
        entryPrice: 64000,
        takeProfitPrice: 68000,
        stopLossPrice: 62000,
      });
      expect(prisma.position.create.mock.calls[0][0].data).toMatchObject({
        takeProfitPrice: 68000,
        stopLossPrice: 62000,
      });

      await service.addManualPosition('u1', {
        symbol: 'BTCUSDT',
        direction: 'long',
        qty: 0.5,
        entryPrice: 64000,
      });
      expect(prisma.position.create.mock.calls[1][0].data).toMatchObject({
        takeProfitPrice: null,
        stopLossPrice: null,
      });
    });

    it('only touches take-profit/stop-loss on update when explicitly provided', async () => {
      prisma.position.findFirst.mockResolvedValue({
        id: 'p1',
        source: 'manual',
        status: 'OPEN',
        side: 'Sell',
        qty: 1,
        avgEntryPrice: 100,
        avgExitPrice: null,
        closedAt: null,
      });
      prisma.position.update.mockResolvedValue({});

      await service.updateManualPosition('u1', 'p1', { takeProfitPrice: 120 });
      expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({ takeProfitPrice: 120 });
      expect(prisma.position.update.mock.calls[0][0].data).not.toHaveProperty('stopLossPrice');
    });

    it('recomputes PnL on update only when trade inputs change', async () => {
      prisma.position.findFirst.mockResolvedValue({
        id: 'p1',
        source: 'manual',
        status: 'CLOSED',
        side: 'Sell',
        qty: 1,
        avgEntryPrice: 100,
        avgExitPrice: 110,
        closedAt: new Date('2026-07-10T00:00:00Z'),
      });
      prisma.position.update.mockResolvedValue({});

      // Date-only edit: the stored (possibly hand-adjusted) PnL must survive.
      await service.updateManualPosition('u1', 'p1', { closedAt: new Date() });
      expect(prisma.position.update.mock.calls[0][0].data).not.toHaveProperty('closedPnl');

      // Price edit: PnL follows.
      await service.updateManualPosition('u1', 'p1', { exitPrice: 130 });
      expect(prisma.position.update.mock.calls[1][0].data.closedPnl).toBe(30);
    });

    it('refuses to edit or delete synced positions', async () => {
      prisma.position.findFirst.mockResolvedValue({ id: 'p1', source: 'bybit' });

      await expect(service.updateManualPosition('u1', 'p1', { qty: 1 })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.removeManualPosition('u1', 'p1')).rejects.toThrow(BadRequestException);
      expect(prisma.position.delete).not.toHaveBeenCalled();
    });

    it('404s on a foreign position', async () => {
      prisma.position.findFirst.mockResolvedValue(null);
      await expect(service.removeManualPosition('u1', 'x')).rejects.toThrow(NotFoundException);
    });

    it('logs a still-open trade when exitPrice/closedAt are omitted, optionally with an entry note', async () => {
      prisma.position.create.mockResolvedValue({ id: 'p1' });

      await service.addManualPosition('u1', {
        symbol: 'btcusdt',
        direction: 'long',
        qty: 0.5,
        entryPrice: 64000,
        note: 'Entered on the breakout above 65k.',
        noteImageUrl: 'https://i.imgur.com/chart123.png',
      });

      const { data } = prisma.position.create.mock.calls[0][0];
      expect(data).toMatchObject({
        status: 'OPEN',
        avgExitPrice: null,
        closedPnl: null,
        closedAt: null,
        notes: {
          create: {
            userId: 'u1',
            body: 'Entered on the breakout above 65k.',
            imageUrl: 'https://i.imgur.com/chart123.png',
          },
        },
      });
    });

    it('rejects exitPrice without closedAt (and vice versa) on create', async () => {
      await expect(
        service.addManualPosition('u1', {
          symbol: 'BTCUSDT',
          direction: 'long',
          qty: 1,
          entryPrice: 100,
          exitPrice: 110,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.position.create).not.toHaveBeenCalled();
    });

    it('closes a still-open manual position when exitPrice and closedAt are supplied', async () => {
      prisma.position.findFirst.mockResolvedValue({
        id: 'p1',
        source: 'manual',
        status: 'OPEN',
        side: 'Sell',
        qty: 1,
        avgEntryPrice: 100,
        avgExitPrice: null,
        closedAt: null,
      });
      prisma.position.update.mockResolvedValue({});

      await service.updateManualPosition('u1', 'p1', { exitPrice: 120, closedAt: new Date() });

      expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({
        avgExitPrice: 120,
        closedPnl: 20,
        status: 'CLOSED',
      });
    });

    it('rejects supplying only exitPrice on a still-open position (closedAt still unresolved)', async () => {
      prisma.position.findFirst.mockResolvedValue({
        id: 'p1',
        source: 'manual',
        status: 'OPEN',
        side: 'Sell',
        qty: 1,
        avgEntryPrice: 100,
        avgExitPrice: null,
        closedAt: null,
      });

      await expect(service.updateManualPosition('u1', 'p1', { exitPrice: 120 })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.position.update).not.toHaveBeenCalled();
    });
  });

  describe('position notes', () => {
    it('adds a note to any owned position regardless of source/status', async () => {
      prisma.position.findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', source: 'bybit' });
      prisma.positionNote.create.mockResolvedValue({ id: 'n1' });

      await service.addPositionNote('u1', 'p1', { body: 'Still holding, thesis intact.' });

      expect(prisma.positionNote.create).toHaveBeenCalledWith({
        data: {
          positionId: 'p1',
          userId: 'u1',
          body: 'Still holding, thesis intact.',
          imageUrl: null,
        },
      });
    });

    it('404s adding a note to a foreign position', async () => {
      prisma.position.findFirst.mockResolvedValue(null);
      await expect(service.addPositionNote('u1', 'p1', { body: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.positionNote.create).not.toHaveBeenCalled();
    });

    it('edits an owned note', async () => {
      prisma.position.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.positionNote.findFirst.mockResolvedValue({ id: 'n1' });
      prisma.positionNote.update.mockResolvedValue({});

      await service.updatePositionNote('u1', 'p1', 'n1', { body: 'Edited reason.' });

      expect(prisma.positionNote.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { body: 'Edited reason.' },
      });
    });

    it('404s editing or deleting a foreign/missing note', async () => {
      prisma.position.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.positionNote.findFirst.mockResolvedValue(null);

      await expect(service.updatePositionNote('u1', 'p1', 'n1', { body: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.removePositionNote('u1', 'p1', 'n1')).rejects.toThrow(NotFoundException);
      expect(prisma.positionNote.delete).not.toHaveBeenCalled();
    });

    it('deletes an owned note', async () => {
      prisma.position.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.positionNote.findFirst.mockResolvedValue({ id: 'n1' });

      await expect(service.removePositionNote('u1', 'p1', 'n1')).resolves.toEqual({
        deleted: true,
      });
      expect(prisma.positionNote.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    });
  });

  describe('holdings', () => {
    it('stores the asset uppercased', async () => {
      prisma.holding.create.mockResolvedValue({});
      await service.addHolding('u1', { asset: 'btc', amount: 0.5, avgBuyPrice: 60000 });
      expect(prisma.holding.create.mock.calls[0][0].data).toMatchObject({
        userId: 'u1',
        asset: 'BTC',
      });
    });

    it('values holdings at current prices with unrealized PnL and a total', async () => {
      prisma.holding.findMany.mockResolvedValue([
        { id: 'h1', asset: 'BTC', amount: 0.5, avgBuyPrice: 60000 },
        { id: 'h2', asset: 'OBSCURE', amount: 100, avgBuyPrice: 1 },
        { id: 'h3', asset: 'USDT', amount: 1000, avgBuyPrice: null },
      ]);
      const priceMap = new Map<string, number>();
      prices.getUsdPrices.mockResolvedValue(priceMap);
      prices.priceOf.mockImplementation((asset: string) =>
        asset === 'BTC' ? 70000 : asset === 'USDT' ? 1 : null,
      );

      const result = await service.listHoldings('u1');

      const [btc, obscure, usdt] = result.items;
      expect(btc).toMatchObject({ value: 35000, pnlUsd: 5000, pnlPct: 16.67 });
      // No ticker → no valuation, but the row is still returned.
      expect(obscure).toMatchObject({ price: null, value: null, pnlUsd: null });
      // No avgBuyPrice → value without PnL.
      expect(usdt).toMatchObject({ value: 1000, pnlUsd: null, pnlPct: null });
      expect(result.totalValue).toBe(36000);
    });

    it('survives prices being unavailable', async () => {
      prisma.holding.findMany.mockResolvedValue([
        { id: 'h1', asset: 'BTC', amount: 1, avgBuyPrice: 60000 },
      ]);
      prices.getUsdPrices.mockResolvedValue(null);

      const result = await service.listHoldings('u1');

      expect(result.items[0]).toMatchObject({ price: null, value: null });
      expect(result.totalValue).toBe(0);
    });

    it('404s on updating or deleting a foreign holding', async () => {
      prisma.holding.findFirst.mockResolvedValue(null);
      await expect(service.updateHolding('u1', 'x', { amount: 1 })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.removeHolding('u1', 'x')).rejects.toThrow(NotFoundException);
      expect(prisma.holding.delete).not.toHaveBeenCalled();
    });
  });
});
