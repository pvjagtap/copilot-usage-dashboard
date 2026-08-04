/**
 * verify-thirdparty-no-rate-estimate.js — a third-party provider's usage must
 * never be priced with GitHub's Copilot rate card.
 *
 * Regression: Azure-hosted Kimi reports no `usage.cost.total`, so the agent
 * block fell back to `calculator.calculateCredits(...)` and printed ~95 credits
 * of spend that never happened. The provider's own cost ledger is the only
 * valid source for non-Copilot traffic.
 */

const assert = require("assert");
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

function session(modelBreakdown, provider) {
  return {
    id: "s1",
    source: "pi",
    provider,
    primaryModel: Object.keys(modelBreakdown)[0],
    modelBreakdown,
    totalTokens: 0,
    llmCalls: 1,
    totalCostCredits: 0,
    firstTs: ts,
    lastTs: ts,
    cwd: "",
  };
}

function mdl(over) {
  return {
    input: 224_067,
    output: 4_521,
    cacheRead: 935_296,
    cacheWrite: 0,
    costCredits: 0,
    llmCalls: 20,
    provider: "",
    ...over,
  };
}

function run(sessions) {
  const scan = { sessions: [], turns: [], toolCalls: [], subagents: [], stats: {} };
  const agentScan = {
    sessions,
    ompSessions: 0,
    piSessions: sessions.length,
    scanMs: 0,
  };
  const longAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  return buildDashboardData(scan, null, undefined, agentScan, longAgo);
}

const nb = (d) => d.aicSummary.nonBillable;
const rowFor = (d, model) => (nb(d).byModel || []).find((r) => r.model === model);

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log("verify-thirdparty-no-rate-estimate");

check("third-party with no cost ledger contributes nothing", () => {
  const d = run([session({ "Kimi-K2.5": mdl({ provider: "kimi-azure" }) }, "kimi-azure")]);
  assert.strictEqual(rowFor(d, "kimi-azure/Kimi-K2.5"), undefined, "kimi row should not exist");
  const total = (nb(d).byModel || []).reduce((s, r) => s + r.totalCredits, 0);
  assert.strictEqual(total, 0, `expected 0 non-billable credits, got ${total}`);
});

check("third-party with a cost ledger reports exactly the ledger value", () => {
  const d = run([
    session(
      { "claude-opus-4-7": mdl({ provider: "azure-anthropic-foundry", costCredits: 178.97 }) },
      "azure-anthropic-foundry"
    ),
  ]);
  const row = rowFor(d, "azure-anthropic-foundry/claude-opus-4-7");
  assert.ok(row, "expected the opus row to exist");
  assert.ok(
    Math.abs(row.totalCredits - 178.97) < 0.01,
    `expected 178.97 credits, got ${row.totalCredits}`
  );
});

check("mixed session excludes only the cost-less third-party model", () => {
  const d = run([
    session(
      {
        "claude-opus-4-7": mdl({ provider: "azure-anthropic-foundry", costCredits: 178.97 }),
        "claude-sonnet-4-6": mdl({ provider: "azure-anthropic-foundry", costCredits: 59.25 }),
        "Kimi-K2.5": mdl({ provider: "kimi-azure" }),
      },
      "azure-anthropic-foundry"
    ),
  ]);
  assert.strictEqual(rowFor(d, "kimi-azure/Kimi-K2.5"), undefined, "kimi row should not exist");
  const total = (nb(d).byModel || []).reduce((s, r) => s + r.totalCredits, 0);
  assert.ok(
    Math.abs(total - 238.22) < 0.02,
    `expected 238.22 non-billable credits, got ${total.toFixed(2)}`
  );
});

check("copilot-routed model without a ledger still falls back to rate estimate", () => {
  const d = run([
    session({ "claude-haiku-4.5": mdl({ provider: "github-copilot" }) }, "github-copilot"),
  ]);
  const billableTotal = d.aicSummary.byModel.reduce((s, r) => s + r.totalCredits, 0);
  assert.ok(billableTotal > 0, "copilot fallback estimate should still produce credits");
});

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
