/**
 * byokPricing.ts — What the user's OWN provider charges for BYOK traffic.
 *
 * GitHub does not bill BYOK requests, so the dashboard reported them in AI
 * credits at Copilot's rate table — i.e. "what this would have cost on
 * Copilot", which is not a number on any invoice the user receives. This
 * module prices the same traffic at the provider's published rates instead.
 *
 * Scope and limits — read before trusting the output:
 *
 *  • **Separate currency, separate bill.** Provider dollars must never be
 *    added to AI credits or reach the headline. They are a different vendor's
 *    charge; the two only coexist as adjacent columns.
 *
 *  • **Cache writes are not observable.** `DebugRequest` carries one `cached`
 *    field, but Anthropic prices cache *writes* at 1.25x base input and cache
 *    *reads* at 0.1x — a 12.5x spread. VS Code does not record which is which,
 *    so `cacheWriteRatio` defaults to 0 (treat all cached tokens as reads) and
 *    the result is documented as a LOWER BOUND rather than presented as exact.
 *
 *  • **Rates are user-editable.** Published prices change; the defaults below
 *    were verified in Sept 2026 and are overridable via
 *    `copilotUsage.byokPricing.providers` without an extension update.
 *
 * Default rates: Anthropic documents that Microsoft Foundry meters token usage
 * at standard per-model Claude API rates, so the Claude API table is also the
 * Foundry rate card. USD per million tokens.
 *   <https://platform.claude.com/docs/en/about-claude/pricing>
 *   <https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry>
 */

/** USD per million tokens for one model on one provider. */
export interface ModelRate {
  /** Case-insensitive substring matched against the model id. */
  match: string;
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache HIT. Anthropic charges 0.1x base input. */
  cachedReadPerMillion: number;
  /** Cache WRITE (5-minute TTL). Anthropic charges 1.25x base input. */
  cacheWritePerMillion: number;
}

export interface ProviderRates {
  /**
   * Case-insensitive substring matched against the provider label the scanner
   * recorded (`Azure Foundry Anthropic`, `Azure-OAI`, `ollama`, …).
   */
  match: string;
  /**
   * Flat multiplier on every rate. Azure US Data Zone Standard deployments
   * bill 1.1x; Global Standard — the default — bills 1.0x.
   */
  regionMultiplier?: number;
  models: ModelRate[];
}

export interface ByokPricingConfig {
  providers: ProviderRates[];
  /**
   * Fraction of `cached` tokens to price as cache WRITES rather than reads.
   * 0 (default) yields the cheapest defensible figure; the panel labels the
   * result a lower bound because of it.
   */
  cacheWriteRatio: number;
}

/** Verified Sept 2026 against Anthropic's published pricing table. */
export const DEFAULT_BYOK_PRICING: ByokPricingConfig = {
  cacheWriteRatio: 0,
  providers: [
    {
      match: "anthropic",
      regionMultiplier: 1.0,
      models: [
        { match: "opus", inputPerMillion: 5.0, outputPerMillion: 25.0, cachedReadPerMillion: 0.5, cacheWritePerMillion: 6.25 },
        { match: "sonnet", inputPerMillion: 2.0, outputPerMillion: 10.0, cachedReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
        { match: "haiku", inputPerMillion: 0.8, outputPerMillion: 4.0, cachedReadPerMillion: 0.08, cacheWritePerMillion: 1.0 },
      ],
    },
  ],
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ProviderCost {
  /** Total USD the provider charges for these tokens. */
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cachedUsd: number;
  /** Rate entry that matched, for display. Absent when nothing matched. */
  matchedProvider?: string;
  matchedModel?: string;
}

/**
 * Longest match wins so a specific entry beats a generic one — otherwise a
 * catch-all `match: "claude"` would shadow every per-model rate behind it.
 */
function bestMatch<T extends { match: string }>(candidates: T[], subject: string): T | undefined {
  const lower = (subject || "").toLowerCase();
  let best: T | undefined;
  for (const c of candidates) {
    const m = (c.match || "").toLowerCase();
    if (!m || !lower.includes(m)) {
      continue;
    }
    if (!best || m.length > best.match.length) {
      best = c;
    }
  }
  return best;
}

/**
 * Price one bucket of tokens. Returns null when no rate matches — the caller
 * must render "unpriced" rather than a misleading $0.00.
 *
 * `providerLabel` and `model` are matched independently: the display label
 * carries the provider name and the model id carries the family, and a
 * qualified id (`Azure Foundry Anthropic/claude-opus-5`) contains both.
 */
export function priceTokens(
  config: ByokPricingConfig,
  providerLabel: string,
  model: string,
  tokens: TokenCounts,
): ProviderCost | null {
  const provider = bestMatch(config.providers ?? [], `${providerLabel} ${model}`);
  if (!provider) {
    return null;
  }
  const rate = bestMatch(provider.models ?? [], model);
  if (!rate) {
    return null;
  }

  const mult = provider.regionMultiplier && provider.regionMultiplier > 0 ? provider.regionMultiplier : 1;
  const writeRatio = Math.min(1, Math.max(0, config.cacheWriteRatio ?? 0));

  // Cached tokens are a SUBSET of input, so charging both would double-bill
  // the same tokens at two rates.
  const cached = Math.max(0, tokens.cachedTokens);
  const netInput = Math.max(0, tokens.inputTokens - cached);
  const cacheWrites = cached * writeRatio;
  const cacheReads = cached - cacheWrites;

  const inputUsd = (netInput / 1_000_000) * rate.inputPerMillion * mult;
  const outputUsd = (Math.max(0, tokens.outputTokens) / 1_000_000) * rate.outputPerMillion * mult;
  const cachedUsd =
    ((cacheReads / 1_000_000) * rate.cachedReadPerMillion +
      (cacheWrites / 1_000_000) * rate.cacheWritePerMillion) *
    mult;

  return {
    totalUsd: inputUsd + outputUsd + cachedUsd,
    inputUsd,
    outputUsd,
    cachedUsd,
    matchedProvider: provider.match,
    matchedModel: rate.match,
  };
}

/** Merge user-supplied providers over the defaults, matching on `match`. */
export function mergePricingConfig(
  overrides: Partial<ByokPricingConfig> | undefined,
): ByokPricingConfig {
  if (!overrides) {
    return DEFAULT_BYOK_PRICING;
  }
  const providers = [...DEFAULT_BYOK_PRICING.providers];
  for (const p of overrides.providers ?? []) {
    if (!p || typeof p.match !== "string" || !p.match.trim()) {
      continue;
    }
    const idx = providers.findIndex(x => x.match.toLowerCase() === p.match.toLowerCase());
    if (idx >= 0) {
      providers[idx] = p;
    } else {
      providers.push(p);
    }
  }
  return {
    providers,
    cacheWriteRatio:
      typeof overrides.cacheWriteRatio === "number"
        ? overrides.cacheWriteRatio
        : DEFAULT_BYOK_PRICING.cacheWriteRatio,
  };
}
