/**
 * report-real-usage.js — what part of the headline number is GitHub's own
 * billing figure, and what part is our rate-table estimate?
 *
 * `copilotUsageNanoAiu` on an `llm_request` debug-log event is the credits
 * GitHub actually billed. Anything without it is reconstructed from the rate
 * table and is an approximation.
 *
 *   node tests/report-real-usage.js --ws-storage "<path>"
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const argv = process.argv.slice(2);
const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i === -1 ? dflt : argv[i + 1]; };
const WS_STORAGE = path.resolve(arg("--ws-storage", path.join(__dirname, "2026-08-07_12-12")));

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

const n = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  if (!fs.existsSync(WS_STORAGE)) { console.error("! no such path: " + WS_STORAGE); process.exit(1); }
  const scan = await scanWorkspaceStorage(WS_STORAGE);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, oneYearAgo);
  const aic = dash.aicSummary;
  const start = aic.billingCycleStart, end = aic.billingCycleEnd;

  // Ground truth vs estimate, straight off the raw requests inside the cycle.
  let truth = 0, est = 0, truthReqs = 0, estReqs = 0;
  const estByModel = new Map();
  for (const t of scan.turns) {
    const reqs = (t.debugRequests && t.debugRequests.length > 0)
      ? t.debugRequests.map(r => ({ day: (r.timestamp || "").slice(0, 10), nano: r.nanoAiu, model: r.model }))
      : (t.timestamp ? [{ day: t.timestamp.slice(0, 10), nano: t.debugAicCredits * 1e9, model: t.modelFamily || "unknown" }] : []);
    for (const r of reqs) {
      if (!r.day || r.day < start || r.day > end) { continue; }
      if (r.nano > 0) { truth += r.nano / 1e9; truthReqs++; }
      else { estReqs++; estByModel.set(r.model, (estByModel.get(r.model) ?? 0) + 1); }
    }
  }

  console.log(`Billing cycle          : ${start} .. ${end}   (${aic.planName} plan, budget ${aic.monthlyBudget})`);
  console.log(`Sessions scanned       : ${dash.sessionsAll.length} total`);
  console.log("");
  console.log(`Dashboard headline     : ${n(aic.totalCredits)} credits`);
  console.log(`  GitHub-billed (nano) : ${n(truth)}  from ${truthReqs.toLocaleString()} requests   <-- REAL`);
  console.log(`  Rate-table estimate  : ${n(aic.totalCredits - truth)}  from ${estReqs.toLocaleString()} requests   <-- approximated`);
  console.log(`  Estimate share       : ${((aic.totalCredits - truth) / aic.totalCredits * 100).toFixed(1)}%`);
  console.log("");
  console.log(`Cost @ $${aic.config.overageCostPerCredit}/credit : $${n(aic.totalCredits * aic.config.overageCostPerCredit)} gross`);
  console.log(`Overage vs budget      : $${n(aic.estimatedOverageCost)}`);
  console.log(`Non-billable (BYOK/local, informational) : ${n(aic.nonBillable.totalCredits)}`);

  if (estReqs > 0) {
    console.log("\nRequests missing copilotUsageNanoAiu, by model:");
    [...estByModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .forEach(([m, c]) => console.log(`  ${String(c).padStart(6)}  ${m}`));
  }

  console.log("\nTop models this cycle (headline basis):");
  aic.byModel.slice(0, 10).forEach(m =>
    console.log(`  ${n(m.totalCredits).padStart(12)}  ${m.model}  [${m.tier}]`));
}

main().catch(e => { console.error(e); process.exit(1); });
