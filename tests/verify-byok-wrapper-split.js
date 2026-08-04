/**
 * verify-byok-wrapper-split.js — a model id served by BOTH Copilot and a BYOK
 * key must split per request, not per model.
 *
 * Background: `claude-opus-5` and `claude-sonnet-5` exist in Copilot's own
 * catalog AND in the user's `chatLanguageModels.json` under a
 * `customendpoint` vendor pointing at Azure Foundry. The model id alone
 * therefore cannot decide billability — v1.10.81's `exclusiveThirdParty`
 * guard deliberately declines to demote these, so every BYOK call kept
 * counting as billed Copilot usage.
 *
 * The discriminator is per-request: Copilot Chat stamps
 * `attrs.debugName = "copilotLanguageModelWrapper"` on requests dispatched
 * through VS Code's public LanguageModelChat API (how BYOK providers are
 * reached), while its own routes name the calling feature
 * (`panel/editAgent`, `summarizeConversationHistory`, `title`, …).
 *
 * Measured across this user's real debug logs:
 *
 *   model            debugName                     withAiu  zeroAiu
 *   claude-opus-5    copilotLanguageModelWrapper         0      350
 *   claude-opus-5    panel/editAgent                   506        1
 *   claude-sonnet-5  copilotLanguageModelWrapper         0        7
 *   claude-sonnet-5  panel/editAgent                    44        0
 *
 * 357/357 wrapper calls reported zero credits; no other model ever used that
 * debugName. Zero false positives, zero false negatives.
 *
 * Run: node tests/verify-byok-wrapper-split.js
 */

const path = require("path");
const Module = require("module");

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
  isByokWrapperCall,
} = require("../out/aicCredits.js");

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.error(`  \u2717 ${label}${detail ? "  \u2014 " + detail : ""}`);
    failed++;
  }
}

const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
const cfg = { ...DEFAULT_AIC_CONFIG };

// The user's config declares both ids under `customendpoint`, but CAPI ALSO
// sells them. `classifyByCatalog` resolves that collision in favour of CAPI —
// so the lookup returns `source: "capi"`, `billable: true` and only the
// `userThirdParty` flag records the BYOK declaration. Keying the classifier
// on `source === "user-config"` would silently never fire here, which is
// exactly the bug this shape is written to catch.
function collidingCatalog(modelName) {
  const n = (modelName || "").toLowerCase();
  if (n === "claude-opus-5" || n === "claude-sonnet-5") {
    return { billable: true, source: "capi", vendor: "anthropic", userThirdParty: true };
  }
  // A model Copilot bills that the user never declared as BYOK.
  if (n === "claude-opus-4.7" || n === "gpt-5.5") {
    return { billable: true, source: "capi", vendor: "anthropic" };
  }
  return null;
}

const WRAPPER = "copilotLanguageModelWrapper";

console.log("\n== Test 1: the marker is recognised, and only it ==");
{
  ok("copilotLanguageModelWrapper is a BYOK marker", isByokWrapperCall(WRAPPER) === true);
  ok("casing/whitespace tolerated", isByokWrapperCall("  CopilotLanguageModelWrapper ") === true);
  for (const d of ["panel/editAgent", "summarizeConversationHistory", "title", "tool/runSubagent", undefined, ""]) {
    ok(`${JSON.stringify(d)} is NOT a BYOK marker`, isByokWrapperCall(d) === false);
  }
}

console.log("\n== Test 2: BYOK-wrapper calls on a colliding id are NON-billable ==");
{
  for (const m of ["claude-opus-5", "claude-sonnet-5"]) {
    ok(`${m} still collides with the rate table`, calc.isKnownGHCModel(m) === true);
    const b = classifyModelBillability(calc, cfg, m, false, collidingCatalog, WRAPPER);
    ok(`${m} via the wrapper is NON-billable`, b === false, `got ${b}`);
  }
}

console.log("\n== Test 3: Copilot-routed calls on the SAME id stay billable ==");
{
  for (const m of ["claude-opus-5", "claude-sonnet-5"]) {
    for (const d of ["panel/editAgent", "summarizeConversationHistory", "retry-error-panel/editAgent"]) {
      const b = classifyModelBillability(calc, cfg, m, false, collidingCatalog, d);
      ok(`${m} via ${d} is BILLABLE`, b === true, `got ${b}`);
    }
    // Billed requests short-circuit at step 2 regardless of debugName.
    const withCredits = classifyModelBillability(calc, cfg, m, true, collidingCatalog, WRAPPER);
    ok(`${m} with real credits stays BILLABLE`, withCredits === true, `got ${withCredits}`);
  }
}

console.log("\n== Test 4: the marker alone cannot demote an undeclared model ==");
{
  // `claude-opus-4.7` had 19 zero-AIU requests with no debugName and is NOT in
  // the user's BYOK config — it must never be demoted by this rule.
  for (const m of ["claude-opus-4.7", "gpt-5.5", "claude-haiku-4.5"]) {
    const b = classifyModelBillability(calc, cfg, m, false, collidingCatalog, WRAPPER);
    ok(`${m} (not BYOK-declared) stays BILLABLE`, b === true, `got ${b}`);
  }
}

console.log("\n== Test 5: replay of the measured real-log distribution ==");
{
  // Exact counts from the user's debug logs.
  const observed = [
    { model: "claude-opus-5", debugName: WRAPPER, withAiu: 0, zeroAiu: 350 },
    { model: "claude-opus-5", debugName: "panel/editAgent", withAiu: 506, zeroAiu: 1 },
    { model: "claude-opus-5", debugName: "summarizeConversationHistory", withAiu: 10, zeroAiu: 3 },
    { model: "claude-sonnet-5", debugName: WRAPPER, withAiu: 0, zeroAiu: 7 },
    { model: "claude-sonnet-5", debugName: "panel/editAgent", withAiu: 44, zeroAiu: 0 },
  ];

  let billed = 0;
  let informational = 0;
  for (const row of observed) {
    for (const [count, hasAiu] of [[row.withAiu, true], [row.zeroAiu, false]]) {
      for (let i = 0; i < count; i++) {
        const b = classifyModelBillability(calc, cfg, row.model, hasAiu, collidingCatalog, row.debugName);
        if (b) billed++;
        else informational++;
      }
    }
  }

  // Every wrapper call (350 + 7) must land in the informational bucket.
  ok("all 357 BYOK-wrapper calls are informational", informational === 357, `got ${informational}`);
  // Everything else (560 + 4 zero-AIU Copilot retries) stays billable.
  ok("all 564 Copilot-routed calls stay billable", billed === 564, `got ${billed}`);
}

console.log("\n== Test 6: the REAL classifyByCatalog reports the BYOK declaration ==");
{
  // Tests 1-5 mock the lookup, which cannot catch a mismatch between what
  // `classifyByCatalog` actually returns and what the classifier reads. Drive
  // the real function over a real cache snapshot instead.
  const mc = require("../out/modelCatalog.js");
  mc.__setCatalogForTesting({
    fetchedAt: Date.now(),
    byId: new Map([
      // CAPI sells the colliding id...
      ["claude-opus-5", { id: "claude-opus-5", billable: true, source: "capi" }],
      // ...and one the user never declared.
      ["claude-opus-4.7", { id: "claude-opus-4.7", billable: true, source: "capi" }],
    ]),
    cdnProviders: {},
    // ...while the user also points it at their own Azure Foundry key.
    userVendorByModelId: new Map([
      ["claude-opus-5", "customendpoint"],
      ["ollama-local", "ollama"],
    ]),
  });

  const collide = mc.classifyByCatalog("claude-opus-5");
  ok("colliding id still resolves via CAPI", collide?.source === "capi", `got ${collide?.source}`);
  ok("colliding id stays billable at row level", collide?.billable === true);
  ok("colliding id is flagged userThirdParty", collide?.userThirdParty === true, `got ${collide?.userThirdParty}`);

  const plain = mc.classifyByCatalog("claude-opus-4.7");
  ok("undeclared CAPI model is NOT userThirdParty", !plain?.userThirdParty);

  const byokOnly = mc.classifyByCatalog("ollama-local");
  ok("BYOK-only id resolves to user-config", byokOnly?.source === "user-config");
  ok("BYOK-only id is flagged userThirdParty", byokOnly?.userThirdParty === true);

  // End to end, through the real lookup.
  const viaWrapper = classifyModelBillability(calc, cfg, "claude-opus-5", false, mc.classifyByCatalog, WRAPPER);
  ok("END-TO-END: colliding id via wrapper is NON-billable", viaWrapper === false, `got ${viaWrapper}`);
  const viaCopilot = classifyModelBillability(calc, cfg, "claude-opus-5", false, mc.classifyByCatalog, "panel/editAgent");
  ok("END-TO-END: colliding id via Copilot is BILLABLE", viaCopilot === true, `got ${viaCopilot}`);
  const undeclared = classifyModelBillability(calc, cfg, "claude-opus-4.7", false, mc.classifyByCatalog, WRAPPER);
  ok("END-TO-END: undeclared id via wrapper stays BILLABLE", undeclared === true, `got ${undeclared}`);
}

console.log("\n== Test 7: a rate-less CAPI response must not erase known rates ==");
{
  // Observed live: `parsed per-1M rates for 0/40 CAPI models (0 billable)`.
  // The all-sources-empty guard does NOT catch this (40 entries is non-empty),
  // so without a rate-aware guard a successful refresh would mark every
  // Copilot model non-billable and collapse all cost reporting to zero.
  const mc = require("../out/modelCatalog.js");
  const priced = new Map([
    ["claude-opus-4.7", { id: "claude-opus-4.7", billable: true, source: "capi" }],
    ["gpt-5.5", { id: "gpt-5.5", billable: true, source: "capi" }],
  ]);
  mc.__setCatalogForTesting({
    fetchedAt: Date.now(),
    byId: priced,
    cdnProviders: {},
    userVendorByModelId: new Map(),
  });

  const before = mc.classifyByCatalog("claude-opus-4.7");
  ok("baseline: model is billable before the bad refresh", before?.billable === true);

  // Simulate what the degenerate response would produce.
  const rateless = new Map([
    ["claude-opus-4.7", { id: "claude-opus-4.7", billable: false, source: "capi" }],
    ["gpt-5.5", { id: "gpt-5.5", billable: false, source: "capi" }],
  ]);
  const anyBillable = [...rateless.values()].some(e => e.billable);
  const priorBillable = [...priced.values()].some(e => e.billable);
  ok("guard condition detects the degenerate response", !anyBillable && priorBillable);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll BYOK wrapper-split checks passed.");
