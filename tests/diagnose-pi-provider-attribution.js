/**
 * diagnose-pi-provider-attribution.js — is agentScanner attributing per-model
 * cost to the right provider?
 *
 * `parseAgentSession` keys its modelBreakdown by model name and records the
 * FIRST provider it sees for that model (`if (!existing.provider && ...)`).
 * When one session calls the same model through two providers (Copilot, then
 * Azure Foundry on fallback), every credit lands on whichever came first —
 * and dashboardData decides billable-vs-not from exactly that field.
 *
 * This compares, over the IDENTICAL session set the extension uses, the true
 * per-message provider split against the scanner's modelBreakdown split.
 *
 *   node tests/diagnose-pi-provider-attribution.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const OUT = path.join(path.resolve(__dirname, ".."), "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));

const n = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isCopilot = (p) => { const s = (p || "").toLowerCase(); return s.includes("github") || s.includes("copilot"); };

async function main() {
  const scan = await scanAgentSessions();
  const pi = scan.sessions.filter(s => s.source === "pi");
  console.log(`Session set: ${pi.length} Pi sessions with lastTs >= ${new Date(scan.billingStart).toISOString().slice(0, 10)}\n`);

  // Truth: re-read those exact files, bucket每 message by its own provider.
  const truth = new Map();
  let mixedModels = 0;
  const mixedDetail = [];
  for (const s of pi) {
    let text;
    try { text = fs.readFileSync(s.filePath, "utf-8"); } catch { continue; }
    const perModelProviders = new Map();
    let sessionProvider = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      if (!sessionProvider && typeof m.provider === "string") sessionProvider = m.provider;
      const p = (typeof m.provider === "string" ? m.provider : sessionProvider) || "(none)";
      const model = typeof m.model === "string" ? m.model : "unknown";
      const cost = (m.usage.cost && typeof m.usage.cost.total === "number") ? m.usage.cost.total * 100 : 0;

      const row = truth.get(p) || { credits: 0, calls: 0 };
      row.credits += cost; row.calls++;
      truth.set(p, row);

      let set = perModelProviders.get(model);
      if (!set) { set = new Map(); perModelProviders.set(model, set); }
      set.set(p, (set.get(p) || 0) + cost);
    }
    for (const [model, provs] of perModelProviders) {
      if (provs.size > 1) {
        mixedModels++;
        mixedDetail.push({ file: path.basename(s.filePath), model, provs: [...provs.entries()] });
      }
    }
  }

  // What the scanner reports.
  const reported = new Map();
  for (const s of pi) {
    for (const [, st] of Object.entries(s.modelBreakdown)) {
      const p = (st.provider || s.provider || "(none)");
      const row = reported.get(p) || { credits: 0, calls: 0 };
      row.credits += st.costCredits; row.calls += st.llmCalls;
      reported.set(p, row);
    }
  }

  const provs = new Set([...truth.keys(), ...reported.keys()]);
  console.log("provider                      truth cr     truth calls    reported cr   reported calls      delta cr");
  let tBill = 0, rBill = 0;
  for (const p of [...provs].sort()) {
    const t = truth.get(p) || { credits: 0, calls: 0 };
    const r = reported.get(p) || { credits: 0, calls: 0 };
    if (isCopilot(p)) { tBill += t.credits; rBill += r.credits; }
    console.log(
      `${p.padEnd(26)} ${n(t.credits).padStart(11)} ${String(t.calls).padStart(13)} ${n(r.credits).padStart(15)} ${String(r.calls).padStart(15)} ${n(r.credits - t.credits).padStart(13)}`
    );
  }

  console.log(`\nBILLABLE (github-copilot) truth : ${n(tBill)} cr`);
  console.log(`BILLABLE (github-copilot) shown : ${n(rBill)} cr`);
  console.log(`OVER-REPORTED                   : ${n(rBill - tBill)} cr  ($${n((rBill - tBill) / 100)})`);

  console.log(`\nmodels called through >1 provider inside a single session: ${mixedModels}`);
  mixedDetail.slice(0, 12).forEach(d =>
    console.log(`  ${d.file}  ${d.model}  ->  ${d.provs.map(([p, c]) => `${p}=${n(c)}`).join("  ")}`));
}

main().catch(e => { console.error(e); process.exit(1); });
