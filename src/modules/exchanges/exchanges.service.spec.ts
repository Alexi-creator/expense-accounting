import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { ExchangesService } from './exchanges.service';

const ROW = {
  id: 'x1',
  userId: 'u1',
  fromCurrency: 'USD',
  fromAmount: 100,
  toCurrency: 'THB',
  toAmount: 3180,
  description: 'SuperRich',
  date: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T10:00:00Z'),
};

describe('ExchangesService', () => {
  let service: ExchangesService;
  let prisma: {
    currencyExchange: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      groupBy: jest.Mock;
    };
  };
  let fx: { convertOn: jest.Mock };

  beforeEach(async () => {
    prisma = {
      currencyExchange: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        groupBy: jest.fn(),
      },
    };
    fx = { convertOn: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        ExchangesService,
        { provide: PrismaService, useValue: prisma },
        { provide: FxRatesService, useValue: fx },
      ],
    }).compile();

    service = module.get(ExchangesService);
  });

  describe('create', () => {
    it('measures the real cost against the mid-market rate of that date', async () => {
      prisma.currencyExchange.create.mockResolvedValue(ROW);
      // Mid-market on that day: 100 USD was worth 3 240 THB.
      fx.convertOn.mockResolvedValue(3240);

      const res = await service.create('u1', ROW);

      expect(fx.convertOn).toHaveBeenCalledWith(100, 'USD', 'THB', ROW.date);
      expect(res.effectiveRate).toBe(31.8);
      expect(res.midMarketRate).toBe(32.4);
      // Lost 60 of 3 240 THB — 1.85%, a measured number rather than an assumed 2%.
      expect(res.costPct).toBe(1.85);
    });

    it('leaves the cost unknown rather than guessing when the date has no rate on record', async () => {
      prisma.currencyExchange.create.mockResolvedValue(ROW);
      fx.convertOn.mockResolvedValue(null);

      const res = await service.create('u1', ROW);

      expect(res.effectiveRate).toBe(31.8); // still known — the user told us both amounts
      expect(res.midMarketRate).toBeNull();
      expect(res.costPct).toBeNull();
    });

    it('rejects an exchange of a currency for itself', async () => {
      await expect(
        service.create('u1', { ...ROW, fromCurrency: 'THB', toCurrency: 'THB' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.currencyExchange.create).not.toHaveBeenCalled();
    });
  });

  describe('movementsByCurrency', () => {
    it('nets what left each currency against what arrived in it', async () => {
      prisma.currencyExchange.groupBy
        .mockResolvedValueOnce([{ fromCurrency: 'USD', _sum: { fromAmount: 100 } }])
        .mockResolvedValueOnce([{ toCurrency: 'THB', _sum: { toAmount: 3180 } }]);

      expect(await service.movementsByCurrency('u1')).toEqual([
        { currency: 'USD', amount: -100 },
        { currency: 'THB', amount: 3180 },
      ]);
    });

    it('collapses a round trip in the same currency into its net', async () => {
      prisma.currencyExchange.groupBy
        .mockResolvedValueOnce([{ fromCurrency: 'USD', _sum: { fromAmount: 100 } }])
        .mockResolvedValueOnce([{ toCurrency: 'USD', _sum: { toAmount: 96 } }]);

      // Bought THB and sold it back: 4 USD is what the two counters kept.
      expect(await service.movementsByCurrency('u1')).toEqual([{ currency: 'USD', amount: -4 }]);
    });
  });

  describe('update', () => {
    it('404s on someone else’s row', async () => {
      prisma.currencyExchange.findFirst.mockResolvedValue(null);
      await expect(service.update('x1', 'u2', { toAmount: 1 })).rejects.toThrow(NotFoundException);
      expect(prisma.currencyExchange.update).not.toHaveBeenCalled();
    });

    it('validates the resulting pair, not just the patch', async () => {
      prisma.currencyExchange.findFirst.mockResolvedValue(ROW);
      // Patch alone looks fine; combined with the stored toCurrency it is THB -> THB.
      await expect(service.update('x1', 'u1', { fromCurrency: 'THB' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
