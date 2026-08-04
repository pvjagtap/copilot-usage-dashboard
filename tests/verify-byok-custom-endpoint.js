/**
 * verify-byok-custom-endpoint.js — BYOK models declared via the documented
 * `models[]` array must be parsed AND must survive a rate-table name
 * collision with a Copilot model of the same id.
 *
 * Real-world config that motivated this (user's chatLanguageModels.json):
 *
 *   [
 *     { "name": "Copilot", "vendor": "copilot", "settings": { "gpt-5.4": {…} } },
 *     { "name": "Azure Foundry Anthropic", "vendor": "customendpoint",
 *       "models": [ { "id": "claude-opus-5", … }, { "id": "claude-sonnet-5", … } ] }
 *   ]
 *
 * Two independent bugs made this traffic look like billed Copilot usage:
 *
 *   1. The parser only read the `settings` object, so `models[].id` was never
 *      seen — `claude-opus-5` / `claude-sonnet-5` never entered the
 *      third-party map at all.
 *   2. Even once parsed, both ids exist verbatim in DEFAULT_MODEL_COSTS
 *      (Copilot ships models with the same names), so `isKnownGHCModel()`
 *      short-circuited to billable before the third-party signal was read.
 *
 * Fix: parse `models[]`, and let an `exclusiveThirdParty` catalog verdict
 * (declared non-Copilot vendor + absent from a loaded CAPI snapshot) skip the
 * rate-table promotion. Alias collisions where CAPI DOES serve the id keep
 * the v1.10.15 behaviour and stay billable.
 *
 * Run: node tests/verify-byok-custom-endpoint.js
 */

const path = require("path");
const Module = require("module");

// `aicCredits.js` imports `vscode`; route it to the shared stub.
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return stubPath;
  }
  return origResolve.call(this, request, ...rest);
};

const {
  AICCalculator,
  DEFAULT_MODEL_COSTS,
  DEFAULT_AIC_CONFIG,
  classifyModelBillability,
} = require("../out/aicCredits.js");
const { parseUserChatLanguageModels } = require("../out/chatLanguageModelsParser.js");

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.error(`  \u2717 ${label}${detail ? "  \u2014 " + detail : ""}`);
    failed++;
  }
}

// ── The user's real config, verbatim in shape ────────────────────────────
const USER_CONFIG = JSON.stringify([
  {
    name: "Copilot",
    vendor: "copilot",
    settings: {
      "gpt-5.4": { reasoningEffort: "high" },
      "claude-sonnet-4.6": { contextSize: 200000 },
    },
  },
  {
    name: "Azure Founday Anthropic",
    vendor: "customendpoint",
    apiKey: "${input:chat.lm.secret.-27b7acf0}",
    models: [
      { id: "claude-opus-5", name: "claude-opus-5", url: "https://x/anthropic/v1/messages" },
      { id: "claude-sonnet-5", name: "claude-sonnet-5", url: "https://x/anthropic/v1/messages" },
    ],
  },
]);

console.log("\n== Test 1: parser reads the documented models[] array ==");
{
  const map = parseUserChatLanguageModels(USER_CONFIG);
  ok("claude-opus-5 recorded as customendpoint", map.get("claude-opus-5") === "customendpoint", `got ${map.get("claude-opus-5")}`);
  ok("claude-sonnet-5 recorded as customendpoint", map.get("claude-sonnet-5") === "customendpoint", `got ${map.get("claude-sonnet-5")}`);
  ok("copilot-vendor gpt-5.4 is NOT third-party", map.has("gpt-5.4") === false);
  ok("copilot-vendor claude-sonnet-4.6 is NOT third-party", map.has("claude-sonnet-4.6") === false);
}

console.log("\n== Test 2: models[] ids that collide with Copilot ids are ambiguous ==");
{
  // Same id under both vendors → omitted, classifier falls back to CAPI.
  const map = parseUserChatLanguageModels(
    JSON.stringify([
      { name: "Copilot", vendor: "copilot", settings: { "claude-opus-5": {} } },
      { name: "BYOK", vendor: "customendpoint", models: [{ id: "claude-opus-5" }] },
    ]),
  );
  ok("id listed under both copilot and BYOK is dropped", map.has("claude-opus-5") === false);
}

const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
const cfg = { ...DEFAULT_AIC_CONFIG };

// Catalog stub: BYOK ids are declared third-party AND absent from CAPI.
function byokExclusiveCatalog(modelName) {
  const n = (modelName || "").toLowerCase();
  if (n === "claude-opus-5" || n === "claude-sonnet-5") {
    return { billable: false, source: "user-config", vendor: "customendpoint", exclusiveThirdParty: true };
  }
  return null;
}

// Catalog stub: same ids declared third-party, but CAPI DOES serve them
// (pure alias collision — the v1.10.15 OMP/Pi/CLI scenario).
function byokAliasCatalog(modelName) {
  const n = (modelName || "").toLowerCase();
  if (n === "claude-opus-5" || n === "claude-sonnet-5") {
    return { billable: false, source: "user-config", vendor: "customendpoint", exclusiveThirdParty: false };
  }
  return null;
}

console.log("\n== Test 3: exclusive BYOK ids are NON-billable despite rate-table collision ==");
{
  ok("claude-opus-5 exists in the rate table (collision is real)", calc.isKnownGHCModel("claude-opus-5") === true);
  ok("claude-sonnet-5 exists in the rate table (collision is real)", calc.isKnownGHCModel("claude-sonnet-5") === true);

  for (const m of ["claude-opus-5", "claude-sonnet-5"]) {
    const b = classifyModelBillability(calc, cfg, m, false, byokExclusiveCatalog);
    ok(`${m} via customendpoint is NON-billable`, b === false, `got ${b}`);
  }
}

console.log("\n== Test 4: alias collision (CAPI serves the id) stays billable ==");
{
  for (const m of ["claude-opus-5", "claude-sonnet-5"]) {
    const b = classifyModelBillability(calc, cfg, m, false, byokAliasCatalog);
    ok(`${m} alias-only demotion is ignored \u2014 still BILLABLE`, b === true, `got ${b}`);
  }
}

console.log("\n== Test 5: Copilot-routed traffic overrides an exclusive BYOK verdict ==");
{
  const b = classifyModelBillability(calc, cfg, "claude-opus-5", false, byokExclusiveCatalog, "github-copilot");
  ok("explicit github-copilot source keeps the row BILLABLE", b === true, `got ${b}`);

  const withCredits = classifyModelBillability(calc, cfg, "claude-opus-5", true, byokExclusiveCatalog);
  ok("hasActualCredits=true keeps the row BILLABLE", withCredits === true, `got ${withCredits}`);
}

console.log("\n== Test 6: unrelated Copilot models are untouched ==");
{
  for (const m of ["gpt-5.4", "claude-sonnet-4.6", "claude-opus-4.7"]) {
    const b = classifyModelBillability(calc, cfg, m, false, byokExclusiveCatalog);
    ok(`${m} is still BILLABLE`, b === true, `got ${b}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll BYOK custom-endpoint checks passed.");
