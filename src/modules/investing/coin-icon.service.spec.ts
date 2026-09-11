import type { ConfigService } from '@nestjs/config';
import type { BybitClient } from './bybit.client';
import { CoinIconService } from './coin-icon.service';

const ENV = { BYBIT_ICON_API_KEY: 'svc-key', BYBIT_ICON_API_SECRET: 'svc-secret' };

function configWith(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('CoinIconService', () => {
  let bybit: { getConvertCoinList: jest.Mock };

  beforeEach(() => {
    bybit = {
      getConvertCoinList: jest.fn().mockResolvedValue([
        { coin: 'BTC', icon: 'https://cdn/btc.svg', iconNight: 'https://cdn/btc-dark.svg' },
        { coin: 'eth', icon: 'https://cdn/eth.svg', iconNight: 'https://cdn/eth-dark.svg' },
        { coin: 'NOICON', icon: '', iconNight: '' },
      ]),
    };
  });

  // Spec files share one process under `bun test`, so a spy on a global (Date.now here) has to be
  // restored or it stays frozen for every file that runs afterwards.
  afterEach(() => jest.restoreAllMocks());

  it('indexes coins by uppercase ticker and serves repeat calls from the cache', async () => {
    const service = new CoinIconService(bybit as unknown as BybitClient, configWith(ENV));

    const icons = await service.getIconMap();
    await service.getIconMap();

    expect(bybit.getConvertCoinList).toHaveBeenCalledTimes(1);
    expect(icons.get('BTC')).toEqual({
      icon: 'https://cdn/btc.svg',
      iconNight: 'https://cdn/btc-dark.svg',
    });
    expect(icons.get('ETH')).toEqual({
      icon: 'https://cdn/eth.svg',
      iconNight: 'https://cdn/eth-dark.svg',
    });
    expect(icons.has('NOICON')).toBe(false); // coins without an icon URL are dropped
  });

  it('returns an empty map without hitting Bybit when the service key is unconfigured', async () => {
    const service = new CoinIconService(bybit as unknown as BybitClient, configWith({}));

    const icons = await service.getIconMap();

    expect(bybit.getConvertCoinList).not.toHaveBeenCalled();
    expect(icons.size).toBe(0);
  });

  it('falls back to the stale cache when the refetch fails, empty without one', async () => {
    const service = new CoinIconService(bybit as unknown as BybitClient, configWith(ENV));
    await service.getIconMap(); // warm the cache
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000); // expire TTL
    bybit.getConvertCoinList.mockRejectedValue(new Error('down'));

    const icons = await service.getIconMap();
    expect(icons.get('BTC')?.icon).toBe('https://cdn/btc.svg');

    const cold = new CoinIconService(bybit as unknown as BybitClient, configWith(ENV));
    const coldIcons = await cold.getIconMap();
    expect(coldIcons.size).toBe(0);
  });
});
