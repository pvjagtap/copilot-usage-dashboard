/**
 * diagnose-pi-byday-rootcause.js — read-only.
 *
 * Isolates the two long-standing `verify-dashboard-vs-api.js` failures:
 *   A. Pi: dash 4986.91 vs truth 28313.55  (-82%)
 *   B. byDay: a day where the dashboard reports credits but truth is 0.00
 *
 * Decides, from live data, whether the dashboard is wrong or the audit's
 * ground-truth recomputation is.
 *
 *   node tests/diagnose-pi-byday-rootcause.js
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

const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));
const { AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));

const usd = (c) => `$${(c * 0.01).toFixed(2)}`;

(async () => {
  const agentScan = await scanAgentSessions();
  const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);

  console.log("=".repeat(78));
  console.log("A. Pi credits: why dashboard (4986.91) != audit truth (28313.55)");
  console.log("=".repeat(78));

  // Reproduce BOTH computations side by side, bucketed by the branch that
  // makes them differ.
  const bucket = {
    thirdPartyLedger: { audit: 0, dash: 0, calls: 0, models: new Map() },
    copilotBillable: { audit: 0, dash: 0, calls: 0, models: new Map() },
    copilotNonBillable: { audit: 0, dash: 0, calls: 0, models: new Map() },
  };

  for (const session of agentScan.sessions) {
    if (session.source === "omp") continue;
    const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
    if (date < AIC_EFFECTIVE_DATE) continue;

    for (const [key, stats] of Object.entries(session.modelBreakdown)) {
      const model = stats.model ?? key;
      const provider = (stats.provider || session.provider || "").toLowerCase();
      const providerIsCopilot = provider.includes("github") || provider.includes("copilot");
      const providerIsThirdParty = provider.length > 0 && !providerIsCopilot;

      // The audit's recomputation: always rate-table, always counted.
      const grossInput = stats.input + stats.cacheRead + stats.cacheWrite;
      const auditCredits = calc.calculateCredits(
        model, grossInput, stats.output, stats.cacheRead, stats.cacheWrite
      ).totalCredits;

      // The dashboard's: ledger for third-party, rate-table only for Copilot.
      let dashCredits;
      if (providerIsThirdParty) {
        dashCredits = stats.costCredits;
      } else {
        const u = stats.unpriced;
        const from = u
          ? u
          : stats.costCredits > 0
            ? null
            : stats;
        const est = from
          ? calc.calculateCredits(
              model, from.input + from.cacheRead + from.cacheWrite, from.output, from.cacheRead, from.cacheWrite
            ).totalCredits
          : 0;
        dashCredits = stats.costCredits + est;
      }

      const b = providerIsThirdParty
        ? bucket.thirdPartyLedger
        : bucket.copilotBillable;
      b.audit += auditCredits;
      b.dash += dashCredits;
      b.calls += stats.calls ?? 0;
      const label = providerIsThirdParty ? `${provider}/${model}` : model;
      const m = b.models.get(label) ?? { audit: 0, dash: 0, ledger: 0 };
      m.audit += auditCredits;
      m.dash += dashCredits;
      m.ledger += stats.costCredits;
      b.models.set(label, m);
    }
  }

  const rows = [
    ["third-party (ledger wins)", bucket.thirdPartyLedger],
    ["copilot-routed (rate-table)", bucket.copilotBillable],
  ];
  console.log("");
  console.log("  bucket                        | audit recompute |  dashboard |     delta");
  console.log("  " + "-".repeat(74));
  let ta = 0, td = 0;
  for (const [name, b] of rows) {
    ta += b.audit; td += b.dash;
    console.log(
      `  ${name.padEnd(29)} | ${b.audit.toFixed(2).padStart(15)} | ${b.dash.toFixed(2).padStart(10)} | ${(b.dash - b.audit).toFixed(2).padStart(9)}`
    );
  }
  console.log("  " + "-".repeat(74));
  console.log(
    `  ${"TOTAL".padEnd(29)} | ${ta.toFixed(2).padStart(15)} | ${td.toFixed(2).padStart(10)} | ${(td - ta).toFixed(2).padStart(9)}`
  );

  console.log("\n  Third-party models — rate-table estimate vs the agent's own ledger:");
  const tp = [...bucket.thirdPartyLedger.models.entries()].sort((a, b) => b[1].audit - a[1].audit);
  if (tp.length === 0) {
    console.log("    (none)");
  }
  for (const [model, m] of tp.slice(0, 12)) {
    console.log(
      `    ${model.padEnd(42)} rate=${m.audit.toFixed(2).padStart(10)} (${usd(m.audit).padStart(9)})  ledger=${m.ledger.toFixed(2).padStart(9)} (${usd(m.ledger)})`
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("B. byDay: which calendar day does each side attribute a session to?");
  console.log("=".repeat(78));

  // The dashboard buckets an agent session by `new Date(lastTs).toISOString()`
  // — a UTC date. Check whether that ever disagrees with the LOCAL date, which
  // is what a per-day table is expected to show.
  let mismatches = 0;
  const sample = [];
  for (const session of agentScan.sessions) {
    const ts = session.lastTs || session.firstTs;
    if (!ts) continue;
    const d = new Date(ts);
    const utcDay = d.toISOString().slice(0, 10);
    const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (utcDay !== localDay) {
      mismatches++;
      if (sample.length < 8) {
        sample.push({ src: session.source, ts: d.toISOString(), utcDay, localDay });
      }
    }
  }
  console.log(`\n  agent sessions whose UTC day != local day: ${mismatches} of ${agentScan.sessions.length}`);
  for (const s of sample) {
    console.log(`    ${s.src.padEnd(4)} ${s.ts}  UTC=${s.utcDay}  LOCAL=${s.localDay}`);
  }

  const now = new Date();
  const utcToday = now.toISOString().slice(0, 10);
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  console.log(`\n  right now: UTC=${utcToday}  LOCAL=${localToday}  offset=${-now.getTimezoneOffset() / 60}h`);
  console.log(
    utcToday !== localToday
      ? "  \u2192 UTC and local are on DIFFERENT days right now: any UTC-keyed bucket\n" +
        "    lands on a day the local-keyed audit reports as 0.00."
      : "  \u2192 same day in both zones at this instant (re-run near local midnight to see the split)."
  );
})();
