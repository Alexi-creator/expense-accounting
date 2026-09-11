import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { BybitApiError, BybitClient } from './bybit.client';

const CREDS = { apiKey: 'test-key', apiSecret: 'test-secret' };

describe('BybitClient', () => {
  let client: BybitClient;
  let fetchMock: jest.Mock;

  const okResponse = (result: unknown) => ({
    ok: true,
    json: async () => ({ retCode: 0, retMsg: 'OK', result }),
  });

  const realFetch = global.fetch;

  beforeEach(() => {
    client = new BybitClient({ get: () => undefined } as unknown as ConfigService);
    fetchMock = jest.fn().mockResolvedValue(okResponse({ list: [], nextPageCursor: '' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  // Every spec file shares one process under `bun test`, so anything patched onto a global has to
  // be put back: a stubbed `fetch` or a frozen `Date.now` would otherwise leak into every file
  // that runs after this one.
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('signs requests per the v5 scheme (timestamp + key + recvWindow + query)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);

    await client.getClosedPnl(CREDS, { category: 'linear', startTime: 1, endTime: 2 });

    const [url, init] = fetchMock.mock.calls[0];
    const query = String(url).split('?')[1];
    expect(String(url)).toContain('/v5/position/closed-pnl');
    expect(query).toContain('category=linear');
    const expected = createHmac('sha256', CREDS.apiSecret)
      .update(`1750000000000${CREDS.apiKey}5000${query}`)
      .digest('hex');
    expect(init.headers).toMatchObject({
      'X-BAPI-API-KEY': 'test-key',
      'X-BAPI-TIMESTAMP': '1750000000000',
      'X-BAPI-SIGN': expected,
    });
  });

  it('omits undefined params from the query string', async () => {
    await client.getExecutions(CREDS, { category: 'linear', startTime: 1, endTime: 2 });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('cursor');
    expect(String(url)).toContain('limit=100');
  });

  it('throws BybitApiError when retCode is non-zero', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ retCode: 10003, retMsg: 'API key is invalid', result: {} }),
    });
    await expect(client.validateKey(CREDS)).rejects.toThrow(BybitApiError);
  });

  it('throws on an HTTP-level failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(client.validateKey(CREDS)).rejects.toThrow('Bybit HTTP 503');
  });

  it('maps validateKey readOnly flag', async () => {
    fetchMock.mockResolvedValue(okResponse({ readOnly: 1 }));
    await expect(client.validateKey(CREDS)).resolves.toEqual({ readOnly: true });

    fetchMock.mockResolvedValue(okResponse({ readOnly: 0 }));
    await expect(client.validateKey(CREDS)).resolves.toEqual({ readOnly: false });
  });

  it('fetches the Convert coin list with the broadest coin/side params', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        coins: [
          { coin: 'BTC', icon: 'https://cdn/btc.svg', iconNight: 'https://cdn/btc-dark.svg' },
        ],
      }),
    );

    const coins = await client.getConvertCoinList(CREDS);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v5/asset/exchange/query-coin-list');
    expect(String(url)).toContain('accountType=eb_convert_uta');
    expect(String(url)).toContain('side=0');
    expect(coins).toEqual([
      { coin: 'BTC', icon: 'https://cdn/btc.svg', iconNight: 'https://cdn/btc-dark.svg' },
    ]);
  });
});
