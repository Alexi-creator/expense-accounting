import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService } from './currency.service';
import { FxRatesService, toDay } from './fx-rates.service';

describe('FxRatesService', () => {
  let service: FxRatesService;
  let prisma: {
    fxRate: { findFirst: jest.Mock; createMany: jest.Mock; update: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let currency: { getRates: jest.Mock };

  beforeEach(async () => {
    prisma = {
      fxRate: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    currency = { getRates: jest.fn().mockResolvedValue({ THB: 32.9 }) };

    const module = await Test.createTestingModule({
      providers: [
        FxRatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CurrencyService, useValue: currency },
      ],
    }).compile();

    service = module.get(FxRatesService);
  });

  describe('rateOn', () => {
    it('uses the rate recorded for that date', async () => {
      prisma.fxRate.findFirst.mockResolvedValue({ rate: '35.5' });

      expect(await service.rateOn('THB', new Date('2026-01-15T00:00:00Z'))).toBe(35.5);
      // Anything on or before the date qualifies, newest first — markets close on weekends.
      expect(prisma.fxRate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { date: 'desc' } }),
      );
      expect(currency.getRates).not.toHaveBeenCalled();
    });

    it('falls back to today only when history does not reach that far back', async () => {
      prisma.fxRate.findFirst.mockResolvedValue(null);

      expect(await service.rateOn('THB', new Date('2019-01-15T00:00:00Z'))).toBe(32.9);
    });

    it('never looks anything up for USD itself', async () => {
      expect(await service.rateOn('USD', new Date())).toBe(1);
      expect(prisma.fxRate.findFirst).not.toHaveBeenCalled();
    });

    it('returns null for a currency nobody knows', async () => {
      expect(await service.rateOn('XYZ', new Date())).toBeNull();
    });
  });

  describe('convertOn', () => {
    it('crosses two currencies through their rates on the same date', async () => {
      // 1 USD = 0.9 EUR = 36 THB on that day.
      prisma.fxRate.findFirst.mockImplementation(({ where }: { where: { currency: string } }) =>
        Promise.resolve({ rate: where.currency === 'EUR' ? '0.9' : '36' }),
      );

      const res = await service.convertOn(3600, 'THB', 'EUR', new Date('2026-01-15T00:00:00Z'));

      expect(res).toBeCloseTo(90); // 3600 / 36 * 0.9
    });

    it('short-circuits a same-currency conversion', async () => {
      expect(await service.convertOn(100, 'THB', 'THB', new Date())).toBe(100);
      expect(prisma.fxRate.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('captureToday', () => {
    it('writes one row per currency for today', async () => {
      prisma.fxRate.createMany.mockResolvedValue({ count: 1 });

      expect(await service.captureToday()).toBe(1);
      expect(prisma.fxRate.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ currency: 'THB', rate: 32.9, source: 'er-api' })],
        skipDuplicates: true,
      });
    });

    it('refreshes a day already captured instead of leaving it stale', async () => {
      prisma.fxRate.createMany.mockResolvedValue({ count: 0 }); // everything was a duplicate

      expect(await service.captureToday()).toBe(1);
      expect(prisma.fxRate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { rate: 32.9, source: 'er-api' } }),
      );
    });

    it('writes nothing rather than a wrong day when rates are unavailable', async () => {
      currency.getRates.mockResolvedValue(null);

      expect(await service.captureToday()).toBe(0);
      expect(prisma.fxRate.createMany).not.toHaveBeenCalled();
    });
  });

  describe('toDay', () => {
    it('drops the time, so one calendar day is one row', () => {
      expect(toDay(new Date('2026-09-01T23:45:12Z')).toISOString()).toBe(
        '2026-09-01T00:00:00.000Z',
      );
    });
  });
});
