import { rupeesToPaise, type GoldRateResponse } from "@goldloan/shared";

export interface GoldRateSnapshot {
  rate24kPaisePerGram: number;
  source: string;
  asOf: Date;
  cachedUntil: Date;
}

export type GoldRateFetcher = () => Promise<{ rate24kPerGram: number; source: string }>;

/**
 * Caches the 24K rate for `ttlSeconds`. Today the fetcher returns the mock ₹7,000/g from config;
 * swapping in a live feed only means passing a different fetcher. Concurrent callers during a
 * refresh share one in-flight request instead of stampeding the upstream.
 */
export class GoldRateService {
  private cached: GoldRateSnapshot | null = null;
  private inFlight: Promise<GoldRateSnapshot> | null = null;

  constructor(
    private readonly fetcher: GoldRateFetcher,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async current(): Promise<GoldRateSnapshot> {
    if (this.cached && this.cached.cachedUntil > this.now()) return this.cached;
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refresh(): Promise<GoldRateSnapshot> {
    const { rate24kPerGram, source } = await this.fetcher();
    const asOf = this.now();
    this.cached = {
      rate24kPaisePerGram: rupeesToPaise(rate24kPerGram),
      source,
      asOf,
      cachedUntil: new Date(asOf.getTime() + this.ttlSeconds * 1000),
    };
    return this.cached;
  }
}

export function toGoldRateResponse(snapshot: GoldRateSnapshot): GoldRateResponse {
  return {
    rate24kPerGram: snapshot.rate24kPaisePerGram / 100,
    currency: "INR",
    source: snapshot.source,
    asOf: snapshot.asOf.toISOString(),
    cachedUntil: snapshot.cachedUntil.toISOString(),
  };
}

export const mockGoldRateFetcher =
  (rate24kPerGram: number): GoldRateFetcher =>
  async () => ({ rate24kPerGram, source: "MOCK" });
