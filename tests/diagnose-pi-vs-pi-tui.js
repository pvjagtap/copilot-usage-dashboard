/**
 * diagnose-pi-vs-pi-tui.js — read-only.
 *
 * Pi's own TUI is the authoritative second opinion on Pi spend: the agent
 * knows which provider served each call and what it actually cost. Compare our
 * per-provider, per-month figures against it to settle whether
 * `verify-dashboard-vs-api.js`'s Pi failure is a dashboard bug or an audit bug.
 *
 *   node tests/diagnose-pi-vs-pi-tui.js
 */

const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

// Transcribed from the Pi TUI "Providers" tab.
const PI_TUI = {
  "2026-08": {
    "azure-anthropic-foundry": { aic: 25978, usd: 259.78, calls: 1910 },
    "github-copilot": { aic: 4987, usd: 49.87, calls: 657 },
    "azure-openai-responses": { aic: 300, usd: 3.0, calls: 76 },
    "kimi-azure": { aic: 135, usd: 1.35, calls: 87 },
    mavis: { aic: 0.3, usd: 0.003, calls: 11 },
  },
  "2026-07": {
    "github-copilot": { aic: 144, usd: 1.44, calls: 46 },
  },
};

(async () => {
  const agentScan = await scanAgentSessions();
  const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);

  // provider → month → { ledger, rate, unpricedRate, calls }
  const acc = new Map();
  for (const s of agentScan.sessions) {
    if (s.source === "omp") continue;
    const ts = s.lastTs || s.firstTs;
    if (!ts) continue;
    const month = new Date(ts).toISOString().slice(0, 7);

    for (const [key, st] of Object.entries(s.modelBreakdown)) {
      const model = st.model ?? key;
      const provider = (st.provider || s.provider || "").toLowerCase() || "(none)";
      const gross = st.input + st.cacheRead + st.cacheWrite;
      const rate = calc.calculateCredits(model, gross, st.output, st.cacheRead, st.cacheWrite).totalCredits;

      // What the dashboard would estimate for the portion the ledger missed.
      const u = st.unpriced;
      const unpricedRate = u
        ? calc.calculateCredits(model, u.input + u.cacheRead + u.cacheWrite, u.output, u.cacheRead, u.cacheWrite).totalCredits
        : 0;

      let byMonth = acc.get(provider);
      if (!byMonth) { byMonth = new Map(); acc.set(provider, byMonth); }
      const row = byMonth.get(month) ?? { ledger: 0, rate: 0, unpricedRate: 0, calls: 0 };
      row.ledger += st.costCredits || 0;
      row.rate += rate;
      row.unpricedRate += unpricedRate;
      row.calls += st.calls || 0;
      byMonth.set(month, row);
    }
  }

  for (const month of ["2026-08", "2026-07"]) {
    console.log("=".repeat(96));
    console.log(`${month}   ours vs Pi's own TUI`);
    console.log("=".repeat(96));
    console.log("  provider                  |   ledger |  +unpriced |     rate |  PI TUI |    delta vs TUI");
    console.log("  " + "-".repeat(92));

    const providers = [...acc.keys()].filter(p => acc.get(p).has(month));
    const tuiMonth = PI_TUI[month] ?? {};
    for (const p of [...new Set([...providers, ...Object.keys(tuiMonth)])].sort()) {
      const r = acc.get(p)?.get(month) ?? { ledger: 0, rate: 0, unpricedRate: 0, calls: 0 };
      const tui = tuiMonth[p];
      const ours = r.ledger + r.unpricedRate;
      const delta = tui ? ours - tui.aic : NaN;
      console.log(
        `  ${p.padEnd(25)} | ${r.ledger.toFixed(2).padStart(8)} | ${ours.toFixed(2).padStart(10)} | ${r.rate.toFixed(2).padStart(8)} | ${(tui ? tui.aic.toFixed(2) : "-").padStart(7)} | ${(tui ? delta.toFixed(2) : "-").padStart(9)}`
      );
    }
  }

  console.log("\n" + "=".repeat(96));
  console.log("Which number should `piTotalCredits` equal?");
  console.log("=".repeat(96));
  let copilotOnly = 0, thirdParty = 0;
  for (const [p, byMonth] of acc) {
    const isCopilot = p.includes("github") || p.includes("copilot");
    for (const [, r] of byMonth) {
      if (isCopilot) copilotOnly += r.ledger + r.unpricedRate;
      else thirdParty += r.ledger + r.unpricedRate;
    }
  }
  console.log(`  copilot-routed only (all months) : ${copilotOnly.toFixed(2)}  ($${(copilotOnly * 0.01).toFixed(2)})`);
  console.log(`  third-party only    (all months) : ${thirdParty.toFixed(2)}  ($${(thirdParty * 0.01).toFixed(2)})`);
  console.log(`  audit's expectation (both, rate) : 28313.55`);
})();
