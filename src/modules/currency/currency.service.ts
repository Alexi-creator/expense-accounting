import { Injectable, Logger } from '@nestjs/common';

// Rates relative to USD: rates[X] = how many units of X per 1 USD.
export type Rates = Record<string, number>;

/**
 * How many units of `currency` one USD bought on `date`; null if that is not knowable at all.
 * Built by FxRatesService.resolverFor over the range a report covers, so valuing a few thousand
 * rows at their own dates still costs one query.
 */
export type RateAt = (currency: string, date: Date) => number | null;

/** An amount that knows when it happened — the input of a period report. */
export type DatedRow = {
  amount: number;
  currency: string;
  amountUsd: number | null;
  date: Date;
};

const BASE = 'USD';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const ENDPOINT = `https://open.er-api.com/v6/latest/${BASE}`;

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);
  private cache: { rates: Rates; fetchedAt: number } | null = null;
  private inflight: Promise<Rates | null> | null = null;

  // Current rates with an in-memory cache. null if the fetch failed and there is no cache.
  async getRates(): Promise<Rates | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return this.cache.rates;
    }
    // Avoid spawning parallel requests to the API.
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchRates().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchRates(): Promise<Rates | null> {
    try {
      const res = await fetch(ENDPOINT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { result?: string; rates?: Rates };
      if (data.result !== 'success' || !data.rates) throw new Error('Invalid rates API response');
      this.cache = { rates: data.rates, fetchedAt: Date.now() };
      return data.rates;
    } catch (err) {
      this.logger.warn(`Failed to fetch currency rates: ${err}`);
      // Return the stale cache if present, otherwise null.
      return this.cache?.rates ?? null;
    }
  }

  // Pure conversion using already-fetched rates. null if the currency is unknown.
  convertWithRates(rates: Rates, amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    const fromRate = from === BASE ? 1 : rates[from];
    const toRate = to === BASE ? 1 : rates[to];
    if (!fromRate || !toRate) return null;
    return (amount / fromRate) * toRate;
  }

  // One-off conversion of a single amount. null if rates are unavailable or the currency is unknown.
  async convert(amount: number, from: string, to: string): Promise<number | null> {
    if (from === to) return amount;
    const rates = await this.getRates();
    if (!rates) return null;
    return this.convertWithRates(rates, amount, from, to);
  }

  // Sum of rows in USD via the snapshot (amountUsd), falling back to the current rate for rows
  // without a snapshot. null if rates are unavailable or an unknown currency was encountered.
  sumUsd(
    rows: { amount: number; currency: string; amountUsd: number | null }[],
    rates: Rates | null,
  ): number | null {
    if (rows.length === 0) return 0;
    if (!rates) return null;

    let usdSum = 0;
    for (const r of rows) {
      const usd =
        r.amountUsd != null
          ? r.amountUsd
          : this.convertWithRates(rates, r.amount, r.currency, BASE);
      if (usd === null) return null;
      usdSum += usd;
    }
    return usdSum;
  }

  // Aggregates a set of amounts into what they are worth in the base currency RIGHT NOW,
  // converting each row individually. For balances, goal progress and anything else asking "how
  // much is this today"; a report over a past period wants historicalTotalInBase instead, which
  // does not let the answer move after the period has closed.
  //
  // Rows already in the base currency are taken directly (no conversion): otherwise the round-trip
  // base -> USD (snapshot) -> base (current rate) at different rates diverges from the sum of the
  // items themselves. Other currencies are converted via USD (amountUsd snapshot, otherwise the
  // current rate), then USD -> base at the current rate.
  // The result is a mid-market estimate: the cost of actually converting is not guessed at here
  // (it belongs to a real exchange the user records), so amounts never silently shrink or grow.
  // Returns null if conversion needs rates and they are unavailable / the currency is unknown.
  approxTotalInBase(
    rows: { amount: number; currency: string; amountUsd: number | null }[],
    baseCurrency: string,
    rates: Rates | null,
  ): number | null {
    let sum = 0;
    for (const r of rows) {
      if (r.currency === baseCurrency) {
        sum += r.amount;
        continue;
      }
      // Row value in USD: the snapshot taken at its operation date, otherwise the current rate.
      const usd =
        r.amountUsd != null ? r.amountUsd : this.convert_(rates, r.amount, r.currency, BASE);
      if (usd === null) return null;
      const inBase = baseCurrency === BASE ? usd : this.convert_(rates, usd, BASE, baseCurrency);
      if (inBase === null) return null;
      sum += inBase;
    }
    return Math.round(sum * 100) / 100;
  }

  // Aggregates rows into the base currency at the rate that held on EACH ROW'S OWN DATE.
  //
  // This is the variant for a report over a period. approxTotalInBase answers a different
  // question — what a pile of money is worth *right now* — which is what a balance or a goal's
  // progress wants. Asking it about a past period makes that period drift: March's total is
  // recomputed at today's rate every time it is opened, so it never settles, and against a
  // high-inflation base currency it drifts one way forever, making the past look ever pricier.
  // Valuing each row at its own date fixes the figure: fx_rates rows never change, so a closed
  // period answers the same number a year from now.
  //
  // Rows already in the base currency are still taken exactly as they are, but the reason has
  // shrunk: it is now only that amountUsd is stored rounded to cents, so the round trip
  // base -> USD -> base would shave a fraction of a unit off every row for nothing. Before, it
  // was papering over two mismatched rate epochs — a systematic error, not a rounding one.
  historicalTotalInBase(rows: DatedRow[], baseCurrency: string, rateAt: RateAt): number | null {
    let sum = 0;
    for (const r of rows) {
      if (r.currency === baseCurrency) {
        sum += r.amount;
        continue;
      }
      const baseRate = rateAt(baseCurrency, r.date);
      if (baseRate === null) return null;
      // Row value in USD: the snapshot taken at its operation date, otherwise that date's rate.
      let usd = r.amountUsd;
      if (usd == null) {
        const ownRate = rateAt(r.currency, r.date);
        if (ownRate === null) return null;
        usd = r.amount / ownRate;
      }
      sum += usd * baseRate;
    }
    return Math.round(sum * 100) / 100;
  }

  // convertWithRates guarded against null rates (needed only for cross-currency rows).
  private convert_(rates: Rates | null, amount: number, from: string, to: string): number | null {
    if (from === to) return amount;
    if (!rates) return null;
    return this.convertWithRates(rates, amount, from, to);
  }
}
