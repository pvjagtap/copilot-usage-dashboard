/**
 * cache.ts — Single source of truth for cache-hit-rate computation across
 * every UI surface (status-bar tooltip, sidebar, dashboard KPI, dashboard
 * per-model and per-session tables).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Between v1.10.53 and v1.10.58 we shipped two consecutive cache-hit bugs
 * caused by the formula and its data source living in 5+ places:
 *   1.10.53 → cached/(prompt+cached)   (under-reported by 2x, since
 *             Copilot's `prompt_tokens` ALREADY includes cached reads —
 *             verified against aicCredits.ts:452)
 *   1.10.57 → three surfaces showing three different values because they
 *             pulled from three different data snapshots (raw OTel receiver,
 *             dashData.liveOtel, sessionsAll filtered by AIC_EFFECTIVE_DATE)
 *
 * Both bugs would have been impossible if there had been ONE function that
 * every surface called. That function is `computeCacheHit()` below.
 *
 * FORMULA
 * -------
 *   hit% = cached / prompt * 100      when prompt > 0
 *          0                          otherwise
 *
 * DO NOT DUPLICATE THIS FORMULA elsewhere. Import `computeCacheHit` instead.
 * If the webview script needs cache-hit values, PRE-COMPUTE them in the
 * extension host using this helper and thread them into the webview data
 * shape — don't inline the arithmetic in the webview.
 */

export type CacheHitTier = "excellent" | "ok" | "cold" | "empty";

export interface CacheHitStats {
  /** cached / prompt * 100, or 0 when prompt is 0. */
  pct: number;
  /** Numerator retained for display sub-lines / hover tables. */
  cached: number;
  /** Denominator retained for display sub-lines / hover tables. */
  prompt: number;
  tier: CacheHitTier;
}

/** Threshold boundaries — kept here so every surface uses the same tiers. */
export const CACHE_HIT_EXCELLENT_MIN = 80;
export const CACHE_HIT_OK_MIN = 30;

export function computeCacheHit(prompt: number, cached: number): CacheHitStats {
  if (!Number.isFinite(prompt) || prompt <= 0) {
    return { pct: 0, cached: cached || 0, prompt: 0, tier: "empty" };
  }
  const c = Number.isFinite(cached) && cached > 0 ? cached : 0;
  const pct = (c / prompt) * 100;
  const tier: CacheHitTier =
    pct >= CACHE_HIT_EXCELLENT_MIN
      ? "excellent"
      : pct >= CACHE_HIT_OK_MIN
        ? "ok"
        : "cold";
  return { pct, cached: c, prompt, tier };
}

/** Short user-facing label for a tier — used in stats-card sub-text. */
export function tierLabel(tier: CacheHitTier): string {
  switch (tier) {
    case "excellent":
      return "excellent reuse";
    case "ok":
      return "some reuse";
    case "cold":
      return "cold cache";
    case "empty":
      return "no data";
  }
}
