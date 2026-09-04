/**
 * Reports what the user's own provider charges for BYOK traffic, from real logs.
 *
 * NOTE ON ACCURACY: this harness stubs `vscode`, so `getCachedCatalog()` is
 * null and BYOK demotion relies on the built-in classifier alone. Rows may
 * therefore differ from the dashboard. Treat this as a shape check on the
 * pricing pipeline, not as a reconciliation against the extension UI.
 */
const path = require("path");
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") { return path.join(__dirname, "_vscode-stub.js"); }
  return origResolve.call(this, request, ...args);
};

const { scanWorkspaceStorage } = require("../out/scanner");
const { scanAgentSessions } = require("../out/agentScanner");
const { scanCliSessions } = require("../out/cliScanner");
const { buildDashboardData } = require("../out/dashboardData");

(async () => {
  const [scan, agentScan, cliScan] = await Promise.all([
    scanWorkspaceStorage(),
    scanAgentSessions().catch(() => undefined),
    scanCliSessions().catch(() => undefined),
  ]);

  const data = buildDashboardData(scan, null, undefined, agentScan, undefined, cliScan, null);
  const nb = data.aicSummary.nonBillable;

  console.log("\nBYOK / non-billable traffic — provider cost\n");
  console.log("model".padEnd(46) + "credits".padStart(12) + "provider $".padStart(14));
  console.log("-".repeat(72));
  for (const m of nb.byModel) {
    const usd = m.providerUsd === undefined ? "unpriced" : "$" + m.providerUsd.toFixed(2);
    console.log(m.model.slice(0, 45).padEnd(46) + m.totalCredits.toFixed(2).padStart(12) + usd.padStart(14));
  }
  console.log("-".repeat(72));
  const total = nb.totalProviderUsd === undefined ? "unpriced" : "$" + nb.totalProviderUsd.toFixed(2);
  console.log("TOTAL".padEnd(46) + nb.totalCredits.toFixed(2).padStart(12) + total.padStart(14));
  console.log("\nCopilot-equivalent credits are what this WOULD have cost on Copilot.");
  console.log("Provider $ is what you are actually billed. They are different currencies.");
  console.log("Cached tokens priced as reads, so the dollar figure is a lower bound.\n");
})();
