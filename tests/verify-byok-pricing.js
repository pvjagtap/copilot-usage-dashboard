/**
 * Verifies BYOK provider pricing.
 *
 * The point of this module is to answer a question AI credits cannot: what
 * does the user's own provider actually charge? Credits were derived with
 * Copilot's rate table, so they are the wrong currency for a bill that
 * Microsoft or Anthropic sends. These checks pin the arithmetic, the
 * matching precedence, and — most importantly — the refusal to invent a
 * $0.00 when no rate is configured.
 */
const assert = require("assert");
const { DEFAULT_BYOK_PRICING, priceTokens, mergePricingConfig } = require("../out/byokPricing");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  PASS  " + name);
  } catch (e) {
    failures++;
    console.log("  FAIL  " + name);
    console.log("        " + e.message);
  }
}

const M = 1_000_000;

console.log("\nBYOK provider pricing\n");

check("opus prices input, output and cache reads at published Claude rates", () => {
  const cost = priceTokens(
    DEFAULT_BYOK_PRICING,
    "Azure Foundry Anthropic/claude-opus-5",
    "claude-opus-5",
    { inputTokens: 2 * M, outputTokens: 1 * M, cachedTokens: 1 * M },
  );
  assert.ok(cost, "expected a priced result");
  // 1M net input @ $5 + 1M output @ $25 + 1M cache read @ $0.50
  assert.strictEqual(Math.round(cost.inputUsd * 100) / 100, 5);
  assert.strictEqual(Math.round(cost.outputUsd * 100) / 100, 25);
  assert.strictEqual(Math.round(cost.cachedUsd * 100) / 100, 0.5);
  assert.strictEqual(Math.round(cost.totalUsd * 100) / 100, 30.5);
});

check("cached tokens are not billed twice as input", () => {
  // The scanner reports `input` as the gross prompt size, cached included.
  // Charging both would roughly double the bill on a cache-heavy workload —
  // and 94% of this user's BYOK input is cached.
  const all = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 0, cachedTokens: 1 * M,
  });
  assert.strictEqual(all.inputUsd, 0, "fully-cached prompt must charge no fresh input");
  assert.strictEqual(Math.round(all.cachedUsd * 100) / 100, 0.5);
});

check("sonnet rates differ from opus", () => {
  const s = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "claude-sonnet-5", {
    inputTokens: 1 * M, outputTokens: 1 * M, cachedTokens: 0,
  });
  assert.strictEqual(Math.round(s.inputUsd * 100) / 100, 2);
  assert.strictEqual(Math.round(s.outputUsd * 100) / 100, 10);
});

check("unknown provider returns null rather than a misleading zero", () => {
  const cost = priceTokens(DEFAULT_BYOK_PRICING, "ollama/llama3", "llama3", {
    inputTokens: 5 * M, outputTokens: 1 * M, cachedTokens: 0,
  });
  assert.strictEqual(cost, null, "no configured rate must be reported as unknown, not free");
});

check("unknown model under a known provider also returns null", () => {
  const cost = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "some-unlisted-model", {
    inputTokens: 1 * M, outputTokens: 0, cachedTokens: 0,
  });
  assert.strictEqual(cost, null);
});

check("cacheWriteRatio splits cached tokens between reads and writes", () => {
  const reads = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 0, cachedTokens: 1 * M,
  });
  const writes = priceTokens(
    mergePricingConfig({ cacheWriteRatio: 1 }),
    "anthropic", "claude-opus-5",
    { inputTokens: 1 * M, outputTokens: 0, cachedTokens: 1 * M },
  );
  assert.strictEqual(Math.round(reads.cachedUsd * 100) / 100, 0.5, "all reads @ $0.50");
  assert.strictEqual(Math.round(writes.cachedUsd * 100) / 100, 6.25, "all 5m writes @ $6.25");
  assert.ok(writes.totalUsd > reads.totalUsd, "the default is the cheaper, lower-bound reading");
});

check("regionMultiplier scales every category", () => {
  const cfg = mergePricingConfig({
    providers: [{ match: "anthropic", regionMultiplier: 1.1, models: DEFAULT_BYOK_PRICING.providers[0].models }],
  });
  const base = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 1 * M, cachedTokens: 0,
  });
  const zone = priceTokens(cfg, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 1 * M, cachedTokens: 0,
  });
  assert.strictEqual(Math.round(zone.totalUsd * 100) / 100, Math.round(base.totalUsd * 1.1 * 100) / 100);
});

check("user overrides replace built-in rates for the same provider", () => {
  const cfg = mergePricingConfig({
    providers: [{ match: "anthropic", models: [{ match: "opus", inputPerMillion: 99, outputPerMillion: 0, cachedReadPerMillion: 0, cacheWritePerMillion: 0 }] }],
  });
  const cost = priceTokens(cfg, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 1 * M, cachedTokens: 0,
  });
  assert.strictEqual(Math.round(cost.inputUsd * 100) / 100, 99, "override must win over the default $5");
});

check("a longer model match beats a shorter one", () => {
  // Guards the case where a user adds a specific deployment rate alongside
  // the generic family rate — the specific one must win regardless of order.
  const cfg = mergePricingConfig({
    providers: [{
      match: "anthropic",
      models: [
        { match: "opus", inputPerMillion: 5, outputPerMillion: 25, cachedReadPerMillion: 0.5, cacheWritePerMillion: 6.25 },
        { match: "claude-opus-5", inputPerMillion: 1, outputPerMillion: 1, cachedReadPerMillion: 1, cacheWritePerMillion: 1 },
      ],
    }],
  });
  const cost = priceTokens(cfg, "anthropic", "claude-opus-5", {
    inputTokens: 1 * M, outputTokens: 0, cachedTokens: 0,
  });
  assert.strictEqual(Math.round(cost.inputUsd * 100) / 100, 1, "specific entry must win");
});

check("zero tokens price to zero without erroring", () => {
  const cost = priceTokens(DEFAULT_BYOK_PRICING, "anthropic", "claude-opus-5", {
    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
  });
  assert.ok(cost, "a matched rate with no traffic is a real $0.00, unlike an unmatched one");
  assert.strictEqual(cost.totalUsd, 0);
});

check("the shipped settings default does not wipe the built-in rates", () => {
  // A user who never opens settings gets the schema default from
  // getConfiguration. If that empty object overrode the defaults instead of
  // merging into them, every BYOK row would silently render as unpriced.
  const pkg = require("../package.json");
  const schemaDefault = pkg.contributes.configuration
    .flatMap(c => Object.entries(c.properties || {}))
    .find(([k]) => k === "copilotUsage.byokPricing")[1].default;
  const tokens = { inputTokens: 1 * M, outputTokens: 0, cachedTokens: 0 };
  for (const cfg of [schemaDefault, undefined, {}]) {
    const cost = priceTokens(mergePricingConfig(cfg), "anthropic", "claude-opus-5", tokens);
    assert.ok(cost, "expected built-in rates to survive config " + JSON.stringify(cfg));
    assert.strictEqual(Math.round(cost.inputUsd * 100) / 100, 5);
  }
});

console.log("\n" + (failures === 0 ? "All checks passed." : failures + " check(s) failed."));
process.exit(failures === 0 ? 0 : 1);
