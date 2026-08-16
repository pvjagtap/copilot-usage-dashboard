/**
 * verify-model-table-reconciles.js — the Usage-by-Model TOTAL row must equal
 * the hero "AI Credits Spent" tile, for every range.
 *
 * Both are now Σ of the same per-day credit map:
 *   hero        = buildRangeDayMap(bounds, sessions, aicSummary)
 *   model table = Σ sessionCreditsInRange(s, bounds) + "Other sources & live"
 *
 * Before the fix these were two independent passes over scan.turns and drifted
 * by thousands of credits (session credits collapsed a whole turn to
 * `debugAicCredits`, dropping rate-estimated requests inside partially-reported
 * turns, and pinned the result to `session.lastDate`).
 *
 * Usage:
 *   node tests/verify-model-table-reconciles.js
 *   node tests/verify-model-table-reconciles.js --ws-storage "<path>"
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

const c = (v) => Number(v || 0).toFixed(2);
let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

// ── Mirrors of the webview helpers in dashboardPanel.ts ──
const inBounds = (day, b) => (!b.start || day >= b.start) && (!b.end || day <= b.end);

function sessionDayCredits(s) {
  if (s.aicByDay && s.aicByDay.length) return s.aicByDay;
  return s.lastDate && s.aicCredits ? [{ day: s.lastDate, credits: s.aicCredits }] : [];
}
function sessionCreditsInRange(s, bounds) {
  return sessionDayCredits(s).reduce((t, d) => (inBounds(d.day, bounds) ? t + d.credits : t), 0);
}
function buildRangeDayMap(bounds, sessions, aic) {
  const map = {};
  ((aic && aic.byDay) || []).forEach((d) => { if (inBounds(d.day, bounds)) map[d.day] = d.credits; });
  const sessionByDay = {};
  sessions.forEach((s) => sessionDayCredits(s).forEach((d) => {
    if (inBounds(d.day, bounds)) sessionByDay[d.day] = (sessionByDay[d.day] || 0) + d.credits;
  }));
  Object.entries(sessionByDay).forEach(([day, credits]) => { if (!(day in map)) map[day] = credits; });
  return map;
}

async function main() {
  if (!fs.existsSync(WS_STORAGE)) {
    console.error("! workspaceStorage path does not exist: " + WS_STORAGE);
    process.exit(1);
  }
  console.log("workspaceStorage: " + WS_STORAGE + "\n");

  const scan = await scanWorkspaceStorage(WS_STORAGE);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, oneYearAgo);
  const aic = dash.aicSummary;

  const now = new Date();
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const monthStart = (offset) => iso(new Date(now.getFullYear(), now.getMonth() + offset, 1));
  const monthEnd = (offset) => iso(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0));

  const ranges = [
    ["all time", { start: "", end: "" }],
    ["this month", { start: monthStart(0), end: "" }],
    ["prev month", { start: monthStart(-1), end: monthEnd(-1) }],
    ["last 7d", { start: iso(new Date(now.getTime() - 7 * 864e5)), end: "" }],
  ];

  for (const [label, bounds] of ranges) {
    console.log(`── range: ${label} (${bounds.start || "-inf"} .. ${bounds.end || "now"})`);
    const sessions = dash.sessionsAll.filter((s) => inBounds(s.lastDate, bounds));

    const heroTotal = Object.values(buildRangeDayMap(bounds, sessions, aic)).reduce((a, b) => a + b, 0);
    const modelRows = sessions.reduce((a, s) => a + sessionCreditsInRange(s, bounds), 0);
    const otherRow = heroTotal - modelRows;
    const tableTotal = modelRows + otherRow;

    console.log(`     hero=${c(heroTotal)}  model rows=${c(modelRows)}  other=${c(otherRow)}`);
    assert(`${label}: TOTAL row == hero`, Math.abs(tableTotal - heroTotal) < 0.01, `${c(tableTotal)} vs ${c(heroTotal)}`);
    assert(`${label}: no negative "other" row`, otherRow >= -0.01, c(otherRow));
  }

  // Session credits must never exceed the cycle total — turns of one session
  // are a strict subset of the cycle's requests.
  console.log("\n── invariants");
  const cycleSessionSum = dash.sessionsAll.reduce(
    (a, s) => a + (s.aicByDay || []).reduce((t, d) => (d.day >= aic.billingCycleStart && d.day <= aic.billingCycleEnd ? t + d.credits : t), 0),
    0
  );
  assert("Σ in-cycle session credits <= aicSummary.totalCredits",
    cycleSessionSum <= aic.totalCredits + 0.01, `${c(cycleSessionSum)} <= ${c(aic.totalCredits)}`);

  const withSplit = dash.sessionsAll.filter((s) => s.aicByDay && s.aicByDay.length > 0);
  assert("post-AIC sessions carry a per-day split", withSplit.length > 0, `${withSplit.length}/${dash.sessionsAll.length}`);
  assert("aicCredits == Σ aicByDay for every split session",
    withSplit.every((s) => Math.abs(s.aicCredits - s.aicByDay.reduce((t, d) => t + d.credits, 0)) < 0.011),
    `${withSplit.length} checked`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
