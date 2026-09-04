/**
 * report-quota-vs-local.js — live drift report.
 *
 * Fetches GitHub's own credit ledger via the `gh` CLI token, runs the real
 * scanner, and prints the reconciled dashboard figures side by side.
 *
 *   node tests/report-quota-vs-local.js
 */

const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
const { scanCliSessions } = require(path.join(OUT, "cliScanner.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));
const { parseQuotaSnapshot } = require(path.join(OUT, "quotaSnapshot.js"));
const { getCachedCatalog } = require(path.join(OUT, "modelCatalog.js"));

function ghToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

(async () => {
  const token = ghToken();
  let snapshot = null;
  if (token) {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "vscode-copilot-usage-dashboard",
      },
    });
    if (res.ok) {
      snapshot = parseQuotaSnapshot(await res.json());
    } else {
      console.log(`quota fetch returned ${res.status}`);
    }
  } else {
    console.log("no gh token available — reporting local figures only");
  }

  // Must mirror extension.ts runScan(): omitting the agent and CLI scans makes
  // the local total disagree with the dashboard by whatever those sources spent.
  const [scan, agentScan, cliScan] = await Promise.all([
    scanWorkspaceStorage(undefined),
    scanAgentSessions().catch(() => undefined),
    scanCliSessions().catch(() => undefined),
  ]);
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, agentScan, undefined, cliScan, snapshot);
  const aic = dash.aicSummary;

  // `loadCatalog()` only runs inside a real ExtensionContext, so BYOK vendor
  // demotion cannot happen here. Without this warning the local total silently
  // counts Azure/BYOK traffic the dashboard correctly excludes.
  if (!getCachedCatalog()) {
    console.log("WARNING: no model catalog in this harness — BYOK/Azure models");
    console.log("         are counted as billable. The local-derived total below");
    console.log("         therefore OVERSTATES what the dashboard shows.");
    console.log("");
  }

  console.log("=".repeat(66));
  console.log("AIC reconciliation");
  console.log("=".repeat(66));
  console.log(`headline totalCredits : ${aic.totalCredits}`);
  console.log(`monthlyBudget         : ${aic.monthlyBudget}`);
  console.log(`creditsRemaining      : ${aic.creditsRemaining}`);
  console.log(`estimatedOverageCost  : $${aic.estimatedOverageCost}`);
  if (aic.quota) {
    console.log("-".repeat(66));
    console.log(`GitHub credits_used   : ${aic.quota.creditsUsed}`);
    console.log(`GitHub entitlement    : ${aic.quota.entitlement}`);
    console.log(`local-derived total   : ${aic.quota.localTotal}${getCachedCatalog() ? "" : "  (inflated — see warning)"}`);
    const nb = aic.nonBillable;
    if (nb && nb.totalCredits > 0) {
      console.log(`non-billable (BYOK)   : ${Math.round(nb.totalCredits * 100) / 100} — excluded from the headline`);
    }
    console.log(`unaccounted delta     : ${aic.quota.localDelta > 0 ? "+" : ""}${aic.quota.localDelta}`);
    const pct = aic.quota.creditsUsed > 0
      ? (aic.quota.localDelta / aic.quota.creditsUsed) * 100 : 0;
    console.log(`delta as % of billed  : ${pct.toFixed(2)}%`);
  }

  const byDaySum = aic.byDay.reduce((s, d) => s + d.credits, 0);
  console.log("-".repeat(66));
  console.log(`byDay sum             : ${byDaySum.toFixed(2)}  (must equal headline)`);
  console.log(`byDay reconciles      : ${Math.abs(byDaySum - aic.totalCredits) < 0.05 ? "YES" : "NO"}`);
})();
