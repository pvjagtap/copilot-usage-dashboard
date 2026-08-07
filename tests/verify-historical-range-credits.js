/**
 * verify-historical-range-credits.js — Guards the regression where every
 * month before AIC_EFFECTIVE_DATE (2026-06-01) rendered 0.0 credits on the
 * dashboard even though full token data existed for those sessions.
 *
 * Root cause was a `date < AIC_EFFECTIVE_DATE` skip inside
 * computeSessionViews(), which zeroed `SessionView.aicCredits` for pre-June
 * turns. The dashboard builds every historical range from that field
 * (aicSummary.byDay only covers the current billing cycle), so the whole
 * pre-AIC history collapsed to zero.
 *
 * Asserts: any month that has prompt tokens also has non-zero credits.
 *
 *   node tests/verify-historical-range-credits.js
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const Module = require("module");
const stubPath = path.join(__dirname, "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  console.log("SKIP: _vscode-stub.js missing — run verify-sidebar-dashboard-parity.js first.");
  process.exit(0);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const { buildDashboardData, AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

(async () => {
  console.log("─".repeat(72));
  console.log("Historical (pre-AIC) range credit check");
  console.log("─".repeat(72));
  console.log(`AIC_EFFECTIVE_DATE = ${AIC_EFFECTIVE_DATE}`);

  const scan = await scanWorkspaceStorage();
  const data = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG);

  // Bucket sessions by month exactly as the webview's range filter does
  // (SessionView.lastDate, then sum aicCredits).
  const byMonth = new Map();
  for (const s of data.sessionsAll) {
    if (!s.lastDate) continue;
    const month = s.lastDate.slice(0, 7);
    const row = byMonth.get(month) ?? { sessions: 0, prompt: 0, credits: 0 };
    row.sessions++;
    row.prompt += s.actualPrompt || s.prompt || 0;
    row.credits += s.aicCredits || 0;
    byMonth.set(month, row);
  }

  const months = [...byMonth.keys()].sort();
  console.log("\n  month     sessions        prompt        credits");
  console.log("  " + "─".repeat(50));
  for (const m of months) {
    const r = byMonth.get(m);
    console.log(
      `  ${m}   ${String(r.sessions).padStart(8)}  ${r.prompt.toLocaleString().padStart(12)}  ` +
        `${r.credits.toFixed(2).padStart(13)}`
    );
  }

  const preAic = months.filter(m => m < AIC_EFFECTIVE_DATE.slice(0, 7));
  if (preAic.length === 0) {
    console.log("\nSKIP: no pre-AIC months in this workspaceStorage.");
    process.exit(0);
  }

  let failed = 0;
  for (const m of preAic) {
    const r = byMonth.get(m);
    if (r.prompt > 0 && r.credits <= 0) {
      failed++;
      console.log(`\n  [FAIL] ${m}: ${r.prompt.toLocaleString()} prompt tokens but 0 credits`);
    } else {
      console.log(`\n  [PASS] ${m}: ${r.credits.toFixed(2)} credits from ${r.prompt.toLocaleString()} prompt tokens`);
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`${preAic.length - failed} of ${preAic.length} pre-AIC months report credits.`);
  process.exit(failed > 0 ? 1 : 0);
})();
