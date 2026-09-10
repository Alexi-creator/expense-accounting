import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CurrencyExchange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FxRatesService } from '../currency/fx-rates.service';
import { CreateExchangeDto, ExchangeDto, UpdateExchangeDto } from './dto/exchange.dto';

/**
 * Currency exchanges: money moving between the user's own currencies.
 *
 * Deliberately not income and not expense — recording an exchange as a pair of those would
 * double-count it in every report. The balance reads these rows to move money between
 * per-currency buckets, and nothing else has to know about them.
 */
@Injectable()
export class ExchangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxRatesService,
  ) {}

  async create(userId: string, dto: CreateExchangeDto): Promise<ExchangeDto> {
    this.assertDifferentCurrencies(dto.fromCurrency, dto.toCurrency);
    const row = await this.prisma.currencyExchange.create({
      data: { ...dto, userId, description: dto.description ?? '' },
    });
    return this.present(row);
  }

  async findAll(userId: string): Promise<ExchangeDto[]> {
    const rows = await this.prisma.currencyExchange.findMany({
      where: { userId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async update(id: string, userId: string, dto: UpdateExchangeDto): Promise<ExchangeDto> {
    const existing = await this.owned(id, userId);
    this.assertDifferentCurrencies(
      dto.fromCurrency ?? existing.fromCurrency,
      dto.toCurrency ?? existing.toCurrency,
    );
    const row = await this.prisma.currencyExchange.update({ where: { id }, data: dto });
    return this.present(row);
  }

  async remove(id: string, userId: string) {
    await this.owned(id, userId);
    return this.prisma.currencyExchange.delete({ where: { id } });
  }

  /**
   * Net effect on each currency: what left one bucket and what landed in another. The balance
   * folds these in as-is — an exchange never needs a rate, because the user already told us the
   * two amounts.
   */
  async movementsByCurrency(userId: string): Promise<{ currency: string; amount: number }[]> {
    const [out, incoming] = await Promise.all([
      this.prisma.currencyExchange.groupBy({
        by: ['fromCurrency'],
        where: { userId },
        _sum: { fromAmount: true },
      }),
      this.prisma.currencyExchange.groupBy({
        by: ['toCurrency'],
        where: { userId },
        _sum: { toAmount: true },
      }),
    ]);

    const net = new Map<string, number>();
    for (const g of out) {
      net.set(g.fromCurrency, (net.get(g.fromCurrency) ?? 0) - Number(g._sum.fromAmount ?? 0));
    }
    for (const g of incoming) {
      net.set(g.toCurrency, (net.get(g.toCurrency) ?? 0) + Number(g._sum.toAmount ?? 0));
    }
    return [...net].map(([currency, amount]) => ({ currency, amount }));
  }

  private async owned(id: string, userId: string): Promise<CurrencyExchange> {
    const row = await this.prisma.currencyExchange.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException(`Exchange ${id} not found`);
    return row;
  }

  private assertDifferentCurrencies(from: string, to: string) {
    if (from === to) throw new BadRequestException('An exchange needs two different currencies');
  }

  /** Adds the derived numbers: the rate the user got, and how far off mid-market it was. */
  private async present(row: CurrencyExchange): Promise<ExchangeDto> {
    const fromAmount = Number(row.fromAmount);
    const toAmount = Number(row.toAmount);
    const effectiveRate = fromAmount === 0 ? 0 : toAmount / fromAmount;

    const midMarketValue = await this.fx.convertOn(
      fromAmount,
      row.fromCurrency,
      row.toCurrency,
      row.date,
    );
    const round = (v: number, digits: number) => {
      const f = 10 ** digits;
      return Math.round(v * f) / f;
    };

    return {
      id: row.id,
      fromCurrency: row.fromCurrency,
      fromAmount,
      toCurrency: row.toCurrency,
      toAmount,
      description: row.description,
      date: row.date,
      effectiveRate: round(effectiveRate, 6),
      midMarketRate:
        midMarketValue === null || fromAmount === 0 ? null : round(midMarketValue / fromAmount, 6),
      // Positive = the exchange cost the user money, which is the normal case.
      costPct:
        midMarketValue === null || midMarketValue === 0
          ? null
          : round(((midMarketValue - toAmount) / midMarketValue) * 100, 2),
    };
  }
}
