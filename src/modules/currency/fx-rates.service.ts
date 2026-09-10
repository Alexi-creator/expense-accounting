import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrencyService, type Rates } from './currency.service';

const BASE = 'USD';
// ECB daily reference rates with a historical range endpoint (~30 currencies), no key. Used to
// backfill dates that predate this table; going forward, history grows from CurrencyService's own
// source, which covers ~160 currencies but only ever knows today.
const HISTORY_ENDPOINT = 'https://api.frankfurter.dev/v1';

/** Truncates a timestamp to a UTC calendar day — the granularity of the `fx_rates` primary key. */
export function toDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date: Date): string {
  return toDay(date).toISOString().slice(0, 10);
}

/**
 * Historical USD rates.
 *
 * `CurrencyService` answers "what is this worth right now"; this service answers "what was it
 * worth on that date". A transaction's USD snapshot is taken at the rate of its operation date,
 * so entering last month's expense today values it correctly, and re-entering it never moves it.
 */
@Injectable()
export class FxRatesService {
  private readonly logger = new Logger(FxRatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Units of `currency` per 1 USD on `date`. Falls back, in order, to the most recent earlier
   * date on record (markets are closed on weekends and holidays), then to today's live rate.
   * null only if the currency is unknown everywhere.
   */
  async rateOn(currency: string, date: Date): Promise<number | null> {
    if (currency === BASE) return 1;

    const row = await this.prisma.fxRate.findFirst({
      where: { currency, date: { lte: toDay(date) } },
      orderBy: { date: 'desc' },
      select: { rate: true },
    });
    if (row) return Number(row.rate);

    // Nothing on or before that date — the table does not reach back that far yet.
    const rates = await this.currency.getRates();
    return rates?.[currency] ?? null;
  }

  /** Converts between two currencies at the rate that held on `date`. */
  async convertOn(amount: number, from: string, to: string, date: Date): Promise<number | null> {
    if (from === to) return amount;
    const [fromRate, toRate] = await Promise.all([this.rateOn(from, date), this.rateOn(to, date)]);
    if (!fromRate || !toRate) return null;
    return (amount / fromRate) * toRate;
  }

  /** Every rate known on `date`, each with the same earlier-date fallback as `rateOn`. */
  async ratesOn(date: Date): Promise<Rates> {
    // DISTINCT ON picks, per currency, the newest row not later than the target date.
    const rows = await this.prisma.$queryRaw<{ currency: string; rate: string }[]>`
      SELECT DISTINCT ON (currency) currency, rate::text AS rate
      FROM fx_rates
      WHERE date <= ${toDay(date)}::date
      ORDER BY currency, date DESC
    `;
    const out: Rates = {};
    for (const r of rows) out[r.currency] = Number(r.rate);
    return out;
  }

  /** Today's snapshot, so that history keeps growing without any manual step. */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async captureToday(): Promise<number> {
    const rates = await this.currency.getRates();
    if (!rates) {
      this.logger.warn('Skipping the daily FX snapshot: rates are unavailable');
      return 0;
    }
    return this.store(new Date(), rates, 'er-api');
  }

  /**
   * Fills the table from the historical source over [from, to]. Existing rows win: a day already
   * captured live is closer to what the user actually saw than the ECB reference rate.
   */
  async backfill(from: Date, to: Date, currencies: string[]): Promise<number> {
    const symbols = currencies.filter((c) => c !== BASE);
    if (symbols.length === 0) return 0;

    const url = `${HISTORY_ENDPOINT}/${isoDay(from)}..${isoDay(to)}?base=${BASE}&symbols=${symbols.join(',')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Historical rates: HTTP ${res.status}`);
    const data = (await res.json()) as { rates?: Record<string, Rates> };
    if (!data.rates) throw new Error('Historical rates: unexpected response shape');

    let written = 0;
    for (const [day, rates] of Object.entries(data.rates)) {
      written += await this.store(new Date(`${day}T00:00:00Z`), rates, 'frankfurter', true);
    }
    return written;
  }

  /** Which currencies the source can serve — the rest have to come from the daily snapshots. */
  async historicalCurrencies(): Promise<string[]> {
    const res = await fetch(`${HISTORY_ENDPOINT}/currencies`);
    if (!res.ok) throw new Error(`Historical currency list: HTTP ${res.status}`);
    return Object.keys((await res.json()) as Record<string, string>);
  }

  private async store(
    date: Date,
    rates: Rates,
    source: string,
    skipExisting = false,
  ): Promise<number> {
    const day = toDay(date);
    const rows = Object.entries(rates)
      .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
      .map(([currency, rate]) => ({ date: day, currency, rate, source }));
    if (rows.length === 0) return 0;

    const result = await this.prisma.fxRate.createMany({ data: rows, skipDuplicates: true });
    if (skipExisting || result.count === rows.length) return result.count;

    // A re-run of the same day (a restart, a manual call): refresh what is already there.
    await Promise.all(
      rows.map((r) =>
        this.prisma.fxRate.update({
          where: { date_currency: { date: r.date, currency: r.currency } },
          data: { rate: r.rate, source },
        }),
      ),
    );
    return rows.length;
  }
}
