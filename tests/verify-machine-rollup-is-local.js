/**
 * verify-machine-rollup-is-local.js
 *
 * The Systems table sums one row per machine, so every figure a machine
 * publishes has to describe only that machine.
 *
 * The regression this pins: `aicSummary.totalCredits` adopts GitHub's
 * `quota_snapshots` figure, which on a pooled Business/Enterprise seat is the
 * whole account's spend. Publishing it as a per-machine rollup made a laptop
 * with three sessions report the org's 42,069 credits, and "Combined this
 * cycle" then added that same account total once per machine.
 *
 *   node tests/verify-machine-rollup-is-local.js
 */
const path = require("path");
const Module = require("module");

const stub = path.join(__dirname, "_vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "vscode") return stub;
  return orig.call(this, req, ...rest);
};

const { buildDashboardData } = require("../out/dashboardData");
const { DEFAULT_AIC_CONFIG } = require("../out/aicCredits");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const today = new Date();
const day = d => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), d))
  .toISOString().slice(0, 10);
const CYCLE_DAY = day(2);

function turn(i, credits) {
  return {
    sessionId: "sess-1",
    turnIndex: i,
    timestamp: CYCLE_DAY + "T10:0" + i + ":00.000Z",
    modelFamily: "claude-opus-5",
    promptTokens: 0,
    outputTokens: 0,
    debugPromptTokens: 100000,
    debugOutputTokens: 1000,
    debugCachedTokens: 95000,
    debugLlmCalls: 1,
    debugAicCredits: credits,
    debugLastRequestAic: credits,
    debugLastRequestTs: CYCLE_DAY + "T10:0" + i + ":00.000Z",
    debugRequests: [{
      timestamp: CYCLE_DAY + "T10:0" + i + ":00.000Z",
      model: "claude-opus-5",
      promptTokens: 100000,
      completionTokens: 1000,
      cachedTokens: 95000,
      cacheWriteTokens: 0,
      nanoAiu: credits * 1e9,
    }],
    toolCallRounds: 0,
    toolCallResults: 0,
    workspaceName: "ws",
  };
}

const scan = {
  sessions: [{
    sessionId: "sess-1",
    workspaceName: "ws",
    modelFamily: "claude-opus-5",
    turnCount: 2,
    totalPromptTokens: 0,
    totalOutputTokens: 0,
    debugTotalPrompt: 200000,
    debugTotalOutput: 2000,
    first: CYCLE_DAY + "T10:00:00.000Z",
    last: CYCLE_DAY + "T10:01:00.000Z",
    lastTurnStartMs: 0, lastTurnEndMs: 0, lastRequestMs: 0, lastRequestModel: "",
  }],
  turns: [turn(0, 30), turn(1, 20)],
  toolCalls: [],
  subagents: [],
  stats: {
    sourceFiles: 1, canonicalSessions: 1, mirroredSessions: 0, mirrorCopiesPruned: 0,
    turnsStored: 2, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0,
    debugLogSessions: 1,
  },
};

// GitHub reports the pooled account: three orders of magnitude above what this
// machine's logs can account for.
const quota = {
  creditsUsed: 42069,
  entitlement: 201900,
  remaining: 159831,
  overageCount: 0,
  overagePermitted: true,
  timestampUtc: new Date().toISOString(),
};

const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, undefined, undefined, quota);
const aic = dash.aicSummary;

console.log("\n1. Headline still adopts GitHub's ledger");
check("totalCredits is the account figure", aic.totalCredits === 42069, String(aic.totalCredits));

console.log("\n2. Local total is exposed separately and is machine-local");
check("localTotalCredits present", typeof aic.localTotalCredits === "number", String(aic.localTotalCredits));
check("localTotalCredits equals this machine's 50 credits",
  Math.abs(aic.localTotalCredits - 50) < 0.01, String(aic.localTotalCredits));
check("localTotalCredits matches the quota diagnostic's localTotal",
  aic.quota && aic.quota.localTotal === aic.localTotalCredits,
  JSON.stringify(aic.quota));

console.log("\n3. localByDay carries no reconciliation delta");
{
  const localSum = aic.localByDay.reduce((s, d) => s + d.credits, 0);
  const reconciledSum = aic.byDay.reduce((s, d) => s + d.credits, 0);
  check("Σ localByDay === localTotalCredits",
    Math.abs(localSum - aic.localTotalCredits) < 0.01, String(localSum));
  check("Σ byDay absorbed the account delta",
    Math.abs(reconciledSum - 42069) < 0.01, String(reconciledSum));
  check("no local day exceeds the local total",
    aic.localByDay.every(d => d.credits <= aic.localTotalCredits + 0.01),
    JSON.stringify(aic.localByDay));
}

console.log("\n4. Per-model rows reconcile with the local total, not the ledger");
{
  const byModelSum = aic.byModel.reduce((s, m) => s + m.totalCredits, 0);
  check("Σ byModel === localTotalCredits",
    Math.abs(byModelSum - aic.localTotalCredits) < 0.01, String(byModelSum));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
