/**
 * verify-agent-gross-input-tokens.js
 *
 * Agent sessions (OMP/Pi) report `input` NET of cache, but the calculator
 * subtracts cache from whatever `inputTokens` it is handed. Passing net makes
 * it subtract twice, and on a cache-heavy session (net 1.8K vs 235M cache-read)
 * the input share clamps to zero — the dashboard then showed `input 0.00` for
 * every Azure-routed Claude row.
 *
 * The ledger total must stay exactly as the agent reported it; only the split
 * across input/output/cached changes.
 */
const path = require("path");
const Module = require("module");
const stub = path.resolve(__dirname, "_vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  return req === "vscode" ? stub : orig.call(this, req, ...rest);
};

const {
  createCalculatorFromConfig,
  DEFAULT_AIC_CONFIG,
} = require("../out/aicCredits.js");

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
let failures = 0;

function report(name, ok, detail) {
  if (!ok) { failures++; }
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Mirrors the apportionment in AICCalculator.computeSummary for a ledger entry. */
function apportion(model, inputTokens, outputTokens, cachedTokens, ledgerCredits) {
  const est = calc.calculateCredits(model, inputTokens, outputTokens, cachedTokens, 0);
  const total = est.inputCredits + est.outputCredits + est.cachedCredits;
  if (total <= 0) {
    return { input: 0, output: 0, cached: 0 };
  }
  const scale = ledgerCredits / total;
  return {
    input: est.inputCredits * scale,
    output: est.outputCredits * scale,
    cached: est.cachedCredits * scale,
  };
}

// Shapes taken from real ~/.omp + ~/.pi sessions.
const rows = [
  { model: "claude-opus-5",   net: 1840,   output: 979232, cacheRead: 235030238, cacheWrite: 4131830, ledger: 18332.34 },
  { model: "claude-sonnet-5", net: 1200,   output: 380734, cacheRead: 77610256,  cacheWrite: 3018778, ledger: 3140.69 },
  { model: "gpt-5.4",         net: 244874, output: 24466,  cacheRead: 3471360,   cacheWrite: 0,       ledger: 184.70 },
];

console.log("\n1. net input (the bug) drives the input share to zero");
for (const r of rows) {
  const bad = apportion(r.model, r.net, r.output, r.cacheRead, r.ledger);
  report(`${r.model}: net input yields 0 input credits`, bad.input === 0);
}

console.log("\n2. gross input restores a non-zero input share");
for (const r of rows) {
  const good = apportion(r.model, r.net + r.cacheRead + r.cacheWrite, r.output, r.cacheRead, r.ledger);
  report(`${r.model}: input credits > 0`, good.input > 0, `input=${good.input.toFixed(2)}`);
}

console.log("\n3. the agent's ledger total is never altered by the split");
for (const r of rows) {
  const good = apportion(r.model, r.net + r.cacheRead + r.cacheWrite, r.output, r.cacheRead, r.ledger);
  const sum = good.input + good.output + good.cached;
  report(`${r.model}: parts sum to the ledger`, Math.abs(sum - r.ledger) < 0.01,
    `${sum.toFixed(2)} vs ${r.ledger}`);
}

console.log("\n4. a session with no cache is unaffected by the change");
const noCache = { model: "gpt-5.5", net: 228371, output: 212, cacheRead: 0, cacheWrite: 0, ledger: 114.82 };
const before = apportion(noCache.model, noCache.net, noCache.output, 0, noCache.ledger);
const after = apportion(noCache.model, noCache.net + 0 + 0, noCache.output, 0, noCache.ledger);
report("gpt-5.5: split identical with and without the fix",
  Math.abs(before.input - after.input) < 1e-9 && Math.abs(before.output - after.output) < 1e-9);

console.log(
  failures === 0
    ? "\nAll agent gross-input checks passed.\n"
    : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
