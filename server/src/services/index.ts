import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { GoldRateService, mockGoldRateFetcher } from "./gold-rate.js";
import { LeadService } from "./leads.js";
import { QuoteService } from "./quotes.js";
import { SchemeService } from "./schemes.js";

export interface Services {
  schemes: SchemeService;
  goldRate: GoldRateService;
  quotes: QuoteService;
  leads: LeadService;
}

export function createServices(db: AppDb, config: AppConfig): Services {
  const schemes = new SchemeService(db);
  const goldRate = new GoldRateService(
    mockGoldRateFetcher(config.GOLD_RATE_24K_PER_GRAM),
    config.GOLD_RATE_CACHE_SECONDS,
  );
  return {
    schemes,
    goldRate,
    quotes: new QuoteService(schemes, goldRate),
    leads: new LeadService(db, schemes, goldRate, {
      duplicateWindowDays: config.DUPLICATE_WINDOW_DAYS,
      idempotencyTtlHours: config.IDEMPOTENCY_TTL_HOURS,
    }),
  };
}
