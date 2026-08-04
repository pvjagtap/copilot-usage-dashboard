/**
 * diagnose-nonbillable-window.js — what is actually behind the
 * "Non-billable models (informational)" panel, per day.
 *
 * Answers three questions the UI can't:
 *   1. What billing-cycle window is the panel summing over (vs. calendar month)?
 *   2. Which days contribute, and how much each?
 *   3. Why is the Output column 0.00 — no output tokens recorded, or a
 *      credit-split fallback in computeSummary?
 *
 * Usage:
 *   node tests/diagnose-nonbillable-window.js
 *   node tests/diagnose-nonbillable-window.js --ws-storage D:/vscode/workspaceStorage
 */

const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const argv = process.argv.slice(2);
function arg(flag, dflt) {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
}
const WS_STORAGE = path.resolve(arg("--ws-storage", "D:/vscode/workspaceStorage"));

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

const n = (v) => Number(v || 0).toLocaleString("en-US");
const c = (v) => Number(v || 0).toFixed(2);

async function main() {
  console.log(`Scanning ${WS_STORAGE} …`);
  const scan = await scanWorkspaceStorage(WS_STORAGE);
  const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, longAgo);
  const aic = dash.aicSummary;
  const nb = aic.nonBillable;

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";

  console.log(`\n── Window ──────────────────────────────────────────────`);
  console.log(`  today                = ${today}`);
  console.log(`  calendar month start = ${monthStart}`);
  console.log(`  billingCycleStart    = ${aic.billingCycleStart}`);
  console.log(`  billingCycleEnd      = ${aic.billingCycleEnd}`);

  console.log(`\n── nonBillable.byModel (whole cycle, what the panel showed pre-1.10.74) ──`);
  for (const m of (nb.byModel || []).slice().sort((a, b) => b.totalCredits - a.totalCredits)) {
    console.log(
      `  ${m.model.padEnd(46)} ${m.tier.padEnd(8)} in=${c(m.inputCredits).padStart(9)} ` +
        `out=${c(m.outputCredits).padStart(8)} cache=${c(m.cachedCredits).padStart(8)} total=${c(m.totalCredits).padStart(9)}`
    );
  }
  const cycleTotal = (nb.byModel || []).reduce((s, m) => s + m.totalCredits, 0);
  console.log(`  ${"".padEnd(46)} ${"".padEnd(8)} cycle total = ${c(cycleTotal)}`);

  console.log(`\n── nonBillable.byDay ───────────────────────────────────`);
  const rows = (nb.byDay || []).slice().sort((a, b) => a.day.localeCompare(b.day));
  if (rows.length === 0) {
    console.log("  (empty — byDay not populated in this payload)");
  }
  const perDay = new Map();
  for (const r of rows) {
    perDay.set(r.day, (perDay.get(r.day) || 0) + r.totalCredits);
    console.log(
      `  ${r.day}  ${r.model.padEnd(46)} ${r.tier.padEnd(8)} total=${c(r.totalCredits).padStart(9)}`
    );
  }

  console.log(`\n── Per-day totals vs. what "this month" should show ─────`);
  let inMonth = 0;
  let beforeMonth = 0;
  for (const [day, total] of Array.from(perDay.entries()).sort()) {
    const tag = day >= monthStart ? "THIS MONTH" : "earlier   ";
    if (day >= monthStart) inMonth += total;
    else beforeMonth += total;
    console.log(`  ${day}  ${tag}  ${c(total).padStart(10)}`);
  }
  console.log(`\n  Σ before ${monthStart} = ${c(beforeMonth)}`);
  console.log(`  Σ on/after ${monthStart} = ${c(inMonth)}`);
  console.log(`  Σ whole cycle          = ${c(inMonth + beforeMonth)}`);

  console.log(`\n── Raw tokens behind the non-billable models ───────────`);
  const nbModels = new Set((nb.byModel || []).map((m) => m.model.toLowerCase()));
  // The panel's ids are vendor-prefixed (third-party via chat.languageModels),
  // which the vscode stub can't reproduce — match them by shape too.
  const isVendorPrefixed = (m) => String(m).includes("/");
  const tok = new Map();
  for (const t of scan.turns || []) {
    if (!t.timestamp) continue;
    const day = t.timestamp.slice(0, 10);
    const add = (model, prompt, output, cached, nano) => {
      const key = String(model).toLowerCase();
      if (!nbModels.has(key) && !isVendorPrefixed(model)) return;
      const k = `${day}\u0000${model}`;
      const e = tok.get(k) || { day, model, prompt: 0, output: 0, cached: 0, nano: 0, calls: 0 };
      e.prompt += prompt || 0;
      e.output += output || 0;
      e.cached += cached || 0;
      e.nano += nano || 0;
      e.calls += 1;
      tok.set(k, e);
    };
    if (t.debugByModel) {
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        add(model, mt.prompt, mt.output, mt.cached, mt.nanoAiu);
      }
    } else {
      add(t.modelFamily, t.debugPromptTokens || t.promptTokens, t.debugOutputTokens || t.outputTokens, 0, 0);
    }
  }
  const tokRows = Array.from(tok.values()).sort(
    (a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)
  );
  if (tokRows.length === 0) console.log("  (no matching turns found)");
  for (const r of tokRows) {
    console.log(
      `  ${r.day}  ${r.model.padEnd(46)} calls=${String(r.calls).padStart(4)} ` +
        `prompt=${n(r.prompt).padStart(12)} output=${n(r.output).padStart(10)} ` +
        `cached=${n(r.cached).padStart(12)} nanoAiu=${n(r.nano).padStart(16)}`
    );
  }

  console.log(`\n── Every model seen, earliest → latest day ─────────────`);
  const span = new Map();
  for (const t of scan.turns || []) {
    if (!t.timestamp) continue;
    const day = t.timestamp.slice(0, 10);
    const models = t.debugByModel ? Object.keys(t.debugByModel) : [t.modelFamily || "unknown"];
    for (const m of models) {
      const e = span.get(m) || { first: day, last: day, calls: 0 };
      if (day < e.first) e.first = day;
      if (day > e.last) e.last = day;
      e.calls += 1;
      span.set(m, e);
    }
  }
  for (const [m, e] of Array.from(span.entries()).sort()) {
    console.log(`  ${m.padEnd(46)} ${e.first} → ${e.last}  turns=${String(e.calls).padStart(5)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
