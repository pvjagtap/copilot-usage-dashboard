/**
 * ttlProviders.ts — Model → cache provider mapping and TTL threshold lookup.
 *
 * The provider matters because each vendor keeps a prompt cache alive for a
 * different (mostly undocumented) window, so thresholds are configured
 * per-provider. Resolution order:
 *
 *   1. `classifyByCatalog(model).vendor` — authoritative, already loaded for
 *      billing classification. Costs nothing extra.
 *   2. Model-id regex — the heuristic inherited from `cache-timer`, used when
 *      the catalog has no vendor for this id (BYOK, brand-new models, CLI).
 *   3. `"default"`.
 *
 * Threshold lookup is derived from the MIT-licensed `cache-timer` extension
 * (© 2026 sukumarp2022); see LICENSE for the attribution notice.
 */

import { classifyByCatalog } from "./modelCatalog";
import type { TtlThresholds } from "./ttlState";

export const DEFAULT_TTL_THRESHOLDS: TtlThresholds = {
  timerValue: 300,
  warnAt: 120,
  alertAt: 30,
};

/** Providers we ship defaults for. Any other string is accepted at runtime. */
export const KNOWN_PROVIDERS = ["anthropic", "openai", "google", "xai", "default"] as const;

/** Vendor strings the catalog may report that aren't a real cache provider. */
const GENERIC_VENDORS = new Set(["copilot", "github", "multiple", "unknown", ""]);

function regexProvider(model: string): string | undefined {
  if (/^claude/i.test(model)) {
    return "anthropic";
  }
  if (/^(gpt|o[0-9]|chatgpt|codex|text-)/i.test(model)) {
    return "openai";
  }
  if (/^gemini/i.test(model)) {
    return "google";
  }
  if (/^grok/i.test(model)) {
    return "xai";
  }
  return undefined;
}

/**
 * Map a model id to a cache-provider key. `vendorHint` lets callers supply a
 * vendor they already know (e.g. from a CLI session record) without paying for
 * a catalog lookup.
 */
export function mapTtlProvider(model: string | undefined, vendorHint?: string): string {
  const m = (model ?? "").trim();
  if (!m) {
    const hint = (vendorHint ?? "").trim().toLowerCase();
    return hint && !GENERIC_VENDORS.has(hint) ? hint : "default";
  }

  const vendor = (classifyByCatalog(m)?.vendor ?? "").trim().toLowerCase();
  if (vendor && !GENERIC_VENDORS.has(vendor)) {
    return vendor;
  }

  const byRegex = regexProvider(m);
  if (byRegex) {
    return byRegex;
  }

  const hint = (vendorHint ?? "").trim().toLowerCase();
  if (hint && !GENERIC_VENDORS.has(hint)) {
    return hint;
  }
  return "default";
}

function intOrDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Resolve thresholds for a provider: provider entry → `default` entry →
 * {@link DEFAULT_TTL_THRESHOLDS}. Values are clamped so downstream state logic
 * always sees `alertAt <= warnAt <= timerValue`.
 */
export function getTtlThresholds(
  provider: string,
  ttlMap?: Record<string, Partial<TtlThresholds>>
): TtlThresholds {
  const map = ttlMap ?? {};
  const own = map[provider] ?? {};
  const def = map["default"] ?? {};
  const pick = (key: keyof TtlThresholds): unknown => own[key] ?? def[key];

  const timerValue = intOrDefault(pick("timerValue"), DEFAULT_TTL_THRESHOLDS.timerValue);
  let warnAt = intOrDefault(pick("warnAt"), DEFAULT_TTL_THRESHOLDS.warnAt);
  let alertAt = intOrDefault(pick("alertAt"), DEFAULT_TTL_THRESHOLDS.alertAt);

  if (warnAt > timerValue) {
    warnAt = timerValue;
  }
  if (alertAt > warnAt) {
    alertAt = warnAt;
  }
  return { timerValue, warnAt, alertAt };
}

/** Largest `timerValue` across the whole map — the widest scan window needed. */
export function maxTimerValue(ttlMap?: Record<string, Partial<TtlThresholds>>): number {
  let max = getTtlThresholds("default", ttlMap).timerValue;
  for (const key of Object.keys(ttlMap ?? {})) {
    const t = getTtlThresholds(key, ttlMap).timerValue;
    if (t > max) {
      max = t;
    }
  }
  return max;
}
