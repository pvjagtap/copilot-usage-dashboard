/**
 * A non-billable BYOK row must keep the provider prefix `dashboardData.ts`
 * attached to it, so `Azure Foundry Anthropic/claude-opus-5` never collapses
 * into a bare `claude-opus-5` that is indistinguishable from the Copilot
 * model of the same name.
 *
 * REGRESSION: `computeSummary` re-labelled rate-estimated rows with the
 * rate-table id (`rate.model`) that `calculateCredits` matched. The
 * `actualCredits` branch already preserved the caller's name for
 * `billable === false`; the estimate branch did not, so exactly the rows the
 * prefix exists for — BYOK traffic, which by definition carries no
 * `copilotUsageNanoAiu` — were the ones that lost it.
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

const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(
  path.join(ROOT, "out", "aicCredits.js")
);

let failed = 0;
function ok(label, cond, extra) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) failed++;
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const today = new Date().toISOString().slice(0, 10);

console.log("== non-billable rows keep their provider prefix ==");
{
  const s = calc.computeSummary([
    // BYOK: rate-estimated, no actualCredits. The prefix must survive.
    {
      model: "Azure Foundry Anthropic/claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 500_000,
      date: today,
      billable: false,
    },
    // BYOK with a provider-supplied cost (OMP/Pi shape) — already worked.
    {
      model: "azure-openai-responses/gpt-5.5",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 0,
      date: today,
      billable: false,
      actualCredits: 42,
    },
    // Copilot-routed traffic on the SAME id must stay bare, so the billable
    // table keeps matching GitHub's own reporting.
    {
      model: "claude-opus-5",
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      cachedTokens: 1_000_000,
      date: today,
      billable: true,
      actualCredits: 100,
    },
  ]);

  const nb = [...s.nonBillable.byModel.keys()];
  const b = [...s.byModel.keys()];

  ok(
    "rate-estimated BYOK row keeps the prefix",
    nb.includes("Azure Foundry Anthropic/claude-opus-5"),
    JSON.stringify(nb)
  );
  ok(
    "ledger-costed BYOK row keeps the prefix",
    nb.includes("azure-openai-responses/gpt-5.5"),
    JSON.stringify(nb)
  );
  ok("no bare id leaks into the non-billable panel", !nb.includes("claude-opus-5"), JSON.stringify(nb));
  ok("billable Copilot row stays bare", b.includes("claude-opus-5"), JSON.stringify(b));

  // The rename must be cosmetic only.
  ok("billable total unchanged by the rename", Math.abs(s.totalCredits - 100) < 1e-9, `${s.totalCredits}`);
  ok(
    "non-billable total still counts both BYOK rows",
    s.nonBillable.totalCredits > 42,
    `${s.nonBillable.totalCredits}`
  );
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
