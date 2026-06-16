// Loyalty tiers — computed from a customer's lifetime spend (Σ payments, full IDR).
// Thresholds (lifetime spend → tier / discount):
//   Bronze   2.5% @ 2,000,000
//   Silver   5%   @ 4,000,000
//   Gold     7.5% @ 6,000,000
//   Platinum 10%  @ 8,000,000
//   Diamond  15%  — top-N customers, PHASE-2. Not threshold-based, so not computed
//                   here (stub only). tierFor never returns 'Diamond'.

export type Tier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';

export interface TierBand {
  tier: Tier;
  discountPct: number;
  threshold: number; // full-IDR lifetime spend required to reach this tier
}

// Ascending by threshold. Diamond is intentionally omitted (phase-2, top-N).
export const TIER_BANDS: TierBand[] = [
  { tier: 'Bronze', discountPct: 2.5, threshold: 2_000_000 },
  { tier: 'Silver', discountPct: 5, threshold: 4_000_000 },
  { tier: 'Gold', discountPct: 7.5, threshold: 6_000_000 },
  { tier: 'Platinum', discountPct: 10, threshold: 8_000_000 },
];

export interface TierResult {
  tier: Tier | null;     // null below Bronze
  discountPct: number;   // 0 below Bronze
}

/** The highest tier whose threshold the lifetime spend has reached (null below Bronze). */
export function tierFor(lifetimeIdr: number): TierResult {
  let result: TierResult = { tier: null, discountPct: 0 };
  for (const band of TIER_BANDS) {
    if (lifetimeIdr >= band.threshold) {
      result = { tier: band.tier, discountPct: band.discountPct };
    }
  }
  return result;
}

export interface NextTier {
  tier: Tier;
  threshold: number;
  remaining: number; // full IDR still needed to reach `tier`
}

/** The next tier up and how much more spend it needs, or null once at/above Platinum
 *  (Diamond is top-N / phase-2, so there is no computable "next" beyond Platinum). */
export function toNextTier(lifetimeIdr: number): NextTier | null {
  for (const band of TIER_BANDS) {
    if (lifetimeIdr < band.threshold) {
      return { tier: band.tier, threshold: band.threshold, remaining: band.threshold - lifetimeIdr };
    }
  }
  return null;
}
