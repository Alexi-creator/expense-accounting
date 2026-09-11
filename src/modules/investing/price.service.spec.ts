import type { BybitClient } from './bybit.client';
import { PriceService } from './price.service';

describe('PriceService', () => {
  let bybit: { getSpotTickers: jest.Mock; getLinearTickers: jest.Mock };
  let service: PriceService;

  beforeEach(() => {
    bybit = {
      getSpotTickers: jest.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', lastPrice: '70000' },
        { symbol: 'ETHUSDT', lastPrice: '3500.5' },
        { symbol: 'BROKEN', lastPrice: 'not-a-number' },
      ]),
      getLinearTickers: jest.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', lastPrice: '70010' },
        { symbol: 'SHIB1000USDT', lastPrice: '0.00654' },
      ]),
    };
    service = new PriceService(bybit as unknown as BybitClient);
  });

  // Spec files share one process under `bun test`, so a spy on a global (Date.now here) has to be
  // restored or it stays frozen for every file that runs afterwards.
  afterEach(() => jest.restoreAllMocks());

  it('indexes tickers and serves repeat calls from the cache', async () => {
    const prices = await service.getUsdPrices();
    await service.getUsdPrices();

    expect(bybit.getSpotTickers).toHaveBeenCalledTimes(1);
    expect(prices?.get('BTCUSDT')).toBe(70000);
    expect(prices?.has('BROKEN')).toBe(false); // unparseable prices are dropped
  });

  it('maps assets to USDT pairs; dollar-pegged assets are 1', async () => {
    const prices = await service.getUsdPrices();
    if (!prices) throw new Error('expected prices');

    expect(service.priceOf('btc', prices)).toBe(70000);
    expect(service.priceOf('USDT', prices)).toBe(1);
    expect(service.priceOf('NOSUCH', prices)).toBeNull();
  });

  it('falls back to the stale cache when the fetch fails, null without one', async () => {
    await service.getUsdPrices(); // warm the cache
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000); // expire TTL
    bybit.getSpotTickers.mockRejectedValue(new Error('down'));

    const prices = await service.getUsdPrices();
    expect(prices?.get('BTCUSDT')).toBe(70000);

    const cold = new PriceService(bybit as unknown as BybitClient);
    await expect(cold.getUsdPrices()).resolves.toBeNull();
  });

  it('keeps a separate cache for linear prices, keyed by the exact symbol (multiplier tickers included)', async () => {
    const linear = await service.getLinearPrices();
    await service.getLinearPrices();

    expect(bybit.getLinearTickers).toHaveBeenCalledTimes(1);
    expect(bybit.getSpotTickers).not.toHaveBeenCalled();
    expect(linear?.get('BTCUSDT')).toBe(70010); // independent from the spot map's 70000
    expect(linear?.get('SHIB1000USDT')).toBe(0.00654);
  });
});
