/**
 * verify-nonbillable-range.js
 *
 * The "Non-billable models (informational)" panel used to render
 * `aic.nonBillable.byModel` verbatim — a whole-billing-cycle aggregate — while
 * every table around it was filtered by the selected date range. Picking
 * "Last 7 days" or a past month left the panel showing full-cycle numbers.
 *
 * `computeSummary` now emits `nonBillable.byDay` (day -> model -> usage) so the
 * webview can re-aggregate for the active range. This pins:
 *   1. byDay exists and reconciles exactly with byModel / totalCredits.
 *   2. Range filtering yields the per-day subset.
 *   3. Zero-credit rows stay in the data but are dropped from display.
 *
 * Run after compile:
 *   node tests/verify-nonbillable-range.js
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(
    stubPath,
    "module.exports = { workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) }, window: {}, commands: {}, Uri: { file: (p) => ({ fsPath: p, toString: () => p }) }, ConfigurationTarget: { Global: 1 }, EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} } };\n"
  );
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ""}`);
    failed++;
  }
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
// Anchor the fixture inside the live billing cycle — computeSummary drops
// anything outside it.
const cycleStart = calc.computeSummary([]).billingCycleStart;
const dayOf = (offset) => {
  const d = new Date(`${cycleStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const dayA = dayOf(0);
const dayB = dayOf(1);

const entry = (model, date, inputTokens, billable) => ({
  model,
  inputTokens,
  outputTokens: 0,
  cachedTokens: 0,
  date,
  billable,
});

const summary = calc.computeSummary([
  entry("claude-sonnet-4.5", dayA, 1_000_000, true),
  entry("ollama/qwen2.5-coder:7b", dayA, 1_000_000, false),
  entry("ollama/qwen2.5-coder:7b", dayB, 2_000_000, false),
  entry("lmstudio/mistral-7b", dayB, 500_000, false),
  // Token-less turn on an unrecognised model: 0 credits, display noise.
  entry("mystery-model", dayB, 0, false),
]);

console.log("== Test 1: nonBillable.byDay reconciles with byModel and total ==");
const nb = summary.nonBillable;
ok("byDay is populated", nb.byDay instanceof Map && nb.byDay.size === 2, `size=${nb.byDay && nb.byDay.size}`);
ok("byDay covers both fixture days", nb.byDay.has(dayA) && nb.byDay.has(dayB));

let byDaySum = 0;
for (const models of nb.byDay.values()) {
  for (const usage of models.values()) {
    byDaySum += usage.totalCredits;
  }
}
ok(
  "sum(byDay) === nonBillable.totalCredits",
  Math.abs(byDaySum - nb.totalCredits) < 1e-9,
  `byDay=${byDaySum} total=${nb.totalCredits}`,
);
ok(
  "billable total excludes every non-billable entry",
  summary.totalCredits > 0 && Math.abs(summary.totalCredits - nb.totalCredits) > 1e-9,
  `billable=${summary.totalCredits} nonBillable=${nb.totalCredits}`,
);

console.log("\n== Test 2: range filter narrows the panel ==");
// Mirrors the webview aggregation in renderAIC (dashboardPanel.ts).
function aggregateForRange(start, end) {
  const rows = new Map();
  let total = 0;
  for (const [day, models] of nb.byDay) {
    if ((start && day < start) || (end && day > end)) {
      continue;
    }
    for (const usage of models.values()) {
      const row = rows.get(usage.model) || { model: usage.model, totalCredits: 0 };
      row.totalCredits += usage.totalCredits;
      rows.set(usage.model, row);
      total += usage.totalCredits;
    }
  }
  return { rows, total };
}

const dayAOnly = aggregateForRange(dayA, dayA);
ok(
  "dayA range only contains the Ollama row",
  dayAOnly.rows.size === 1 && dayAOnly.rows.has("ollama/qwen2.5-coder:7b"),
  JSON.stringify([...dayAOnly.rows.keys()]),
);
ok(
  "dayA range total is strictly less than the cycle total",
  dayAOnly.total > 0 && dayAOnly.total < nb.totalCredits,
  `range=${dayAOnly.total} cycle=${nb.totalCredits}`,
);

const fullRange = aggregateForRange(null, null);
ok(
  "unbounded range reproduces the cycle total",
  Math.abs(fullRange.total - nb.totalCredits) < 1e-9,
  `range=${fullRange.total} cycle=${nb.totalCredits}`,
);

console.log("\n== Test 3: zero-credit rows are data-complete but not displayed ==");
ok("mystery-model is tracked in byModel", nb.byModel.has("mystery-model"));
ok("mystery-model contributes 0 credits", nb.byModel.get("mystery-model").totalCredits === 0);
const displayed = [...fullRange.rows.values()].filter(r => r.totalCredits >= 0.005);
ok(
  "zero-credit row is filtered out of the rendered table",
  !displayed.some(r => r.model === "mystery-model"),
  JSON.stringify(displayed.map(r => r.model)),
);
ok("non-zero rows survive the display filter", displayed.length === 2, JSON.stringify(displayed.map(r => r.model)));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll non-billable range checks passed.");
