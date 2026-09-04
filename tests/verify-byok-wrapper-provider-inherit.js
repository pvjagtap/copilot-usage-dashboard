/**
 * verify-byok-wrapper-provider-inherit.js
 *
 * One physical BYOK endpoint must produce ONE row in the non-billable panel.
 *
 * REGRESSION: a `copilotLanguageModelWrapper` request proves BYOK routing but
 * carries no provider name of its own — the name lives on the turn. VS Code
 * stamps `vendor: copilot` on the turn whenever the model picker happens to
 * sit on a Copilot model, even while the wrapper dispatches to the user's own
 * key. `vendorFor()` then returned undefined and the row rendered bare, so a
 * single Azure endpoint split into `Azure Foundry Anthropic/claude-opus-5`
 * AND a bare `claude-opus-5` in the same table. Measured on real logs: 3,815
 * labelled requests vs 408 unlabelled, for one endpoint.
 */
const path = require("path");
const Module = require("module");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const stub = path.join(__dirname, "_vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "vscode") return stub;
  return orig.call(this, req, parent, ...rest);
};

const { buildDashboardData } = require(path.join(ROOT, "out", "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(ROOT, "out", "aicCredits.js"));

let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

const DAY = new Date().toISOString().slice(0, 10);
const TS = `${DAY}T10:00:00.000Z`;

function req(model, debugName, nanoAiu = 0) {
  return { timestamp: TS, model, prompt: 1_000_000, output: 100_000, cached: 0, nanoAiu, debugName };
}

function turn(id, vendor, provider, family, requests) {
  return {
    sessionId: id, turnId: id + "-t", timestamp: TS,
    modelFamily: family, modelVendor: vendor, modelProvider: provider,
    promptTokens: 0, outputTokens: 0,
    debugPromptTokens: 0, debugOutputTokens: 0, debugCachedTokens: 0,
    debugAicCredits: 0, debugLlmCalls: requests.length,
    debugRequests: requests,
  };
}

function build(turns) {
  const scan = {
    sessions: turns.map(t => ({
      sessionId: t.sessionId, project: "p", firstDate: DAY, lastDate: DAY,
      turns: 1, toolCalls: 0, promptTokens: 0, outputTokens: 0,
      models: [t.modelFamily], aicCredits: 0, aicByDay: [],
    })),
    turns,
    toolCalls: [], subagents: [],
    stats: { sourceFiles: 1, canonicalSessions: turns.length, mirroredSessions: 0,
             mirrorCopiesPruned: 0, turnsStored: turns.length, toolCallsStored: 0,
             promptPreviews: 0, transcriptsFound: 0, debugLogSessions: 1 },
  };
  return buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, undefined, undefined, null);
}

console.log("\nBYOK wrapper rows inherit the provider their session established");

// Turn A records the Azure provider. Turn B is the same endpoint mid-session
// with the picker on a Copilot model, so VS Code stamped vendor=copilot.
const dash = build([
  turn("a", "customendpoint", "Azure Foundry Anthropic", "claude-opus-5",
       [req("claude-opus-5", "copilotLanguageModelWrapper")]),
  turn("b", "copilot", undefined, "claude-opus-5",
       [req("claude-opus-5", "copilotLanguageModelWrapper")]),
]);
const nbModels = (dash.aicSummary.nonBillable.byModel || []).map(m => m.model);

check("one endpoint yields exactly one non-billable row", () => {
  assert.strictEqual(nbModels.length, 1, `got rows: ${JSON.stringify(nbModels)}`);
});

check("that row carries the provider prefix", () => {
  assert.strictEqual(nbModels[0], "Azure Foundry Anthropic/claude-opus-5");
});

check("no bare id survives alongside the labelled one", () => {
  assert.ok(!nbModels.includes("claude-opus-5"),
    "a bare claude-opus-5 row is still splitting the endpoint in two");
});

// A wrapper call must not borrow a provider for a model that endpoint never
// served — that would relabel unrelated BYOK traffic.
const other = build([
  turn("a", "customendpoint", "Azure Foundry Anthropic", "claude-opus-5",
       [req("claude-opus-5", "copilotLanguageModelWrapper")]),
  turn("b", "copilot", undefined, "gpt-5.6-terra",
       [req("some-unknown-model", "copilotLanguageModelWrapper")]),
]);
check("inheritance is keyed by model, not applied blanket", () => {
  const rows = (other.aicSummary.nonBillable.byModel || []).map(m => m.model);
  assert.ok(!rows.includes("Azure Foundry Anthropic/some-unknown-model"),
    `unrelated model wrongly labelled: ${JSON.stringify(rows)}`);
});

// Copilot-routed traffic must keep a bare id so the billable table still
// matches GitHub's own reporting.
const billed = build([
  turn("a", "customendpoint", "Azure Foundry Anthropic", "claude-opus-5",
       [req("claude-opus-5", "copilotLanguageModelWrapper")]),
  turn("b", "copilot", undefined, "claude-opus-5",
       [req("claude-opus-5", "panel/editAgent", 5_000_000_000)]),
]);
check("billable Copilot rows stay bare", () => {
  const rows = (billed.aicSummary.byModel || []).map(m => m.model);
  assert.ok(rows.includes("claude-opus-5"), `billable rows: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some(r => r.includes("/")), `a prefix leaked into billable: ${JSON.stringify(rows)}`);
});

console.log(failed === 0 ? "\nAll checks passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
