/**
 * diagnose-pi-cost-coverage.js — how much agent usage carries a real
 * `usage.cost.total`, and what happens to the rest?
 *
 * dashboardData.ts gates on the per-model SUM:
 *     actualCredits = stats.costCredits > 0 ? stats.costCredits : rateEstimate(...)
 * If a model has 47 calls and only 1 carries a cost, the sum is > 0, so the
 * other 46 are never priced — a silent under-report. Same bug class as the
 * per-turn `debugAicCredits > 0` gate fixed for VS Code in 1.10.91.
 *
 *   node tests/diagnose-pi-cost-coverage.js
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));

const n = v => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const scan = await scanAgentSessions();
  const agents = scan.sessions;
  console.log(`billing period from ${new Date(scan.billingStart).toISOString().slice(0, 10)} — ${agents.length} agent sessions\n`);

  // Per (provider, model): call counts split by whether cost.total was recorded.
  const rows = new Map();
  for (const s of agents) {
    let text;
    try { text = fs.readFileSync(s.filePath, "utf-8"); } catch { continue; }
    let sessionProvider = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      if (!sessionProvider && typeof m.provider === "string") sessionProvider = m.provider;
      const prov = (typeof m.provider === "string" ? m.provider : sessionProvider) || "(none)";
      const model = typeof m.model === "string" ? m.model : "unknown";
      const key = `${prov} :: ${model}`;
      const r = rows.get(key) || { calls: 0, priced: 0, unpriced: 0, usd: 0, unpricedTokens: 0 };
      r.calls++;
      const c = m.usage.cost;
      const total = c && typeof c.total === "number" ? c.total : 0;
      if (total > 0) { r.priced++; r.usd += total; }
      else {
        r.unpriced++;
        r.unpricedTokens += (m.usage.input || 0) + (m.usage.output || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      }
      rows.set(key, r);
    }
  }

  console.log("provider :: model                                calls  priced  unpriced   recorded$   unpriced tokens");
  let anyPartial = false;
  [...rows.entries()].sort((a, b) => b[1].calls - a[1].calls).forEach(([k, r]) => {
    const partial = r.priced > 0 && r.unpriced > 0;
    if (partial) anyPartial = true;
    console.log(
      `${k.slice(0, 44).padEnd(46)}${String(r.calls).padStart(5)}${String(r.priced).padStart(8)}${String(r.unpriced).padStart(10)}` +
      `${n(r.usd).padStart(12)}${r.unpricedTokens.toLocaleString().padStart(18)}${partial ? "   <-- PARTIAL" : ""}`
    );
  });

  console.log(`\nrows with partial cost coverage: ${anyPartial ? "YES — under-report risk" : "none in this window"}`);

  // All-time: how often is cost.total absent/zero at all?
  let tot = 0, priced = 0;
  const root = path.dirname(path.dirname(agents[0]?.filePath || ""));
  const walk = d => { let o = []; let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return o; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) o = o.concat(walk(p)); else if (e.name.endsWith(".jsonl")) o.push(p); } return o; };
  for (const f of walk(path.dirname(root))) {
    let text; try { text = fs.readFileSync(f, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      tot++;
      const c = m.usage.cost;
      if (c && typeof c.total === "number" && c.total > 0) priced++;
    }
  }
  console.log(`\nall-time assistant messages: ${tot.toLocaleString()}   with cost.total > 0: ${priced.toLocaleString()} (${(priced / tot * 100).toFixed(1)}%)`);
  console.log(`=> ${(100 - priced / tot * 100).toFixed(1)}% must come from the rate table (copilot-routed only).`);
})();
