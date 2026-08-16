/**
 * verify-agent-cost-coverage.js — agent calls that recorded no
 * `usage.cost.total` must still be priced (Copilot-routed only).
 *
 * Regression: dashboardData gated on the per-model SUM —
 *     actualCredits = stats.costCredits > 0 ? stats.costCredits : rateEstimate(...)
 * so a model with 47 calls where only 1 carried a cost reported that single
 * call and silently dropped the other 46. Agents populate `usage.cost` on a
 * minority of messages (12.8% across the observed Pi history), so partial
 * coverage is the normal case. Same bug class as the per-turn
 * `debugAicCredits > 0` gate fixed for VS Code in 1.10.91.
 *
 * Third-party providers still get NO rate estimate — GitHub's rate card does
 * not price Azure/Anthropic-direct traffic (see verify-thirdparty-no-rate-estimate.js).
 *
 *   node tests/verify-agent-cost-coverage.js
 */

const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { buildDashboardData } = require(path.join(ROOT, "out", "dashboardData.js"));

const day = new Date().toISOString().slice(0, 10);
const ts = new Date(`${day}T10:00:00.000Z`).getTime();

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

function run(modelBreakdown, provider) {
  const scan = { sessions: [], turns: [], toolCalls: [], subagents: [], stats: {} };
  const agentScan = {
    sessions: [{
      id: "s1", source: "pi", provider,
      primaryModel: "claude-opus-5",
      modelBreakdown,
      totalTokens: 0, llmCalls: 1, totalCostCredits: 0,
      firstTs: ts, lastTs: ts, cwd: "",
    }],
    ompSessions: 0, piSessions: 1, scanMs: 0,
  };
  const longAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  return buildDashboardData(scan, null, undefined, agentScan, longAgo);
}

// One priced call (2.50 credits recorded) plus one unpriced call carrying real
// tokens. Both must be counted.
const PRICED = 2.5;
const partialCopilot = {
  "github-copilot::claude-opus-5": {
    model: "claude-opus-5",
    provider: "github-copilot",
    input: 200_000, output: 10_000, cacheRead: 500_000, cacheWrite: 0,
    costCredits: PRICED,
    llmCalls: 2,
    unpriced: { input: 100_000, output: 5_000, cacheRead: 250_000, cacheWrite: 0, calls: 1 },
  },
};

const d1 = run(partialCopilot, "github-copilot");
const billable1 = d1.aicSummary.totalCredits;
console.log("Copilot-routed, partial cost coverage");
assert("credits exceed the recorded ledger alone", billable1 > PRICED + 0.01, `${billable1.toFixed(2)} > ${PRICED}`);
assert("unpriced calls contribute a rate estimate", billable1 - PRICED > 0, (billable1 - PRICED).toFixed(2));

// Same row with the unpriced bucket empty must equal the ledger exactly.
const fullyPriced = {
  "github-copilot::claude-opus-5": {
    ...partialCopilot["github-copilot::claude-opus-5"],
    unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  },
};
const d2 = run(fullyPriced, "github-copilot");
assert("fully-priced row equals the ledger (no double count)",
  Math.abs(d2.aicSummary.totalCredits - PRICED) < 0.01, d2.aicSummary.totalCredits.toFixed(2));

// Third-party: unpriced tokens must NOT be rate-estimated.
console.log("\nThird-party provider, partial cost coverage");
const partialThirdParty = {
  "kimi-azure::Kimi-K2.5": {
    model: "Kimi-K2.5",
    provider: "kimi-azure",
    input: 200_000, output: 10_000, cacheRead: 500_000, cacheWrite: 0,
    costCredits: 0.03,
    llmCalls: 47,
    unpriced: { input: 190_000, output: 9_500, cacheRead: 480_000, cacheWrite: 0, calls: 46 },
  },
};
const d3 = run(partialThirdParty, "kimi-azure");
const nbRow = (d3.aicSummary.nonBillable.byModel || []).find(r => r.model === "kimi-azure/Kimi-K2.5");
assert("third-party row stays non-billable", !!nbRow, JSON.stringify((d3.aicSummary.nonBillable.byModel || []).map(r => r.model)));
assert("third-party headline unaffected", d3.aicSummary.totalCredits === 0, d3.aicSummary.totalCredits);
if (nbRow) {
  assert("third-party uses ledger only — no rate estimate",
    Math.abs(nbRow.totalCredits - 0.03) < 0.01, nbRow.totalCredits.toFixed(4));
}

// Provider keying: one model served by two providers in one session must stay split.
console.log("\nSame model, two providers, one session");
const split = {
  "github-copilot::claude-opus-5": {
    model: "claude-opus-5", provider: "github-copilot",
    input: 1000, output: 100, cacheRead: 0, cacheWrite: 0,
    costCredits: 1.0, llmCalls: 1,
    unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  },
  "azure-anthropic-foundry::claude-opus-5": {
    model: "claude-opus-5", provider: "azure-anthropic-foundry",
    input: 1000, output: 100, cacheRead: 0, cacheWrite: 0,
    costCredits: 9.0, llmCalls: 1,
    unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  },
};
const d4 = run(split, "github-copilot");
assert("only the Copilot half is billable",
  Math.abs(d4.aicSummary.totalCredits - 1.0) < 0.01, d4.aicSummary.totalCredits.toFixed(2));
const azureRow = (d4.aicSummary.nonBillable.byModel || []).find(r => r.model === "azure-anthropic-foundry/claude-opus-5");
assert("Azure half lands in non-billable at its own cost",
  !!azureRow && Math.abs(azureRow.totalCredits - 9.0) < 0.01,
  azureRow ? azureRow.totalCredits.toFixed(2) : "missing");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
