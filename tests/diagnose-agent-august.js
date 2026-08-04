/**
 * diagnose-agent-august.js — reproduce agentScanner's per-model/provider
 * credit aggregation directly from the Pi/OMP session ledgers, so the
 * dashboard's "non-billable" rows can be checked against source data.
 *
 * Mirrors src/agentScanner.ts:
 *   cost credits = usage.cost.total (USD) * 100
 *   session date = max(msg timestamp) → YYYY-MM-DD
 *   display model = `${provider}/${model}` when provider is not GitHub/Copilot
 *
 * Usage: node tests/diagnose-agent-august.js [--from 2026-08-01]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
const FROM = arg("--from", new Date().toISOString().slice(0, 8) + "01");

const roots = [
  { label: "omp", dir: path.join(os.homedir(), ".omp", "agent", "sessions") },
  {
    label: "pi",
    dir: path.join(process.env["PI_CODING_AGENT_DIR"] || path.join(os.homedir(), ".pi", "agent"), "sessions"),
  },
];

function walk(dir, acc = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(p);
  }
  return acc;
}

const byDayModel = new Map();
const sessionRows = [];

for (const { label, dir } of roots) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    const models = new Map();
    let lastTs = 0;
    let firstTs = 0;
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = e && e.message;
      if (!msg || typeof msg !== "object") continue;
      let ts = 0;
      if (typeof msg.timestamp === "number" && msg.timestamp > 0) ts = msg.timestamp;
      else if (typeof e.timestamp === "string") ts = new Date(e.timestamp).getTime();
      if (ts > 0) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      const u = msg.usage;
      if (!u || typeof u !== "object") continue;
      const cost = u.cost && typeof u.cost.total === "number" ? u.cost.total * 100 : 0;
      const model = typeof msg.model === "string" ? msg.model : "unknown";
      const provider = typeof msg.provider === "string" ? msg.provider : "";
      const key = `${provider}\u0000${model}`;
      const m = models.get(key) || {
        model,
        provider,
        credits: 0,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
      };
      m.credits += cost;
      m.calls += 1;
      m.input += u.input || 0;
      m.output += u.output || 0;
      m.cacheRead += u.cacheRead || 0;
      models.set(key, m);
    }
    if (models.size === 0) continue;
    const date = new Date(lastTs || firstTs).toISOString().slice(0, 10);
    if (date < FROM) continue;
    for (const m of models.values()) {
      const p = m.provider.toLowerCase();
      const isCopilot = p.includes("github") || p.includes("copilot");
      const thirdParty = p.length > 0 && !isCopilot;
      const display = thirdParty ? `${m.provider}/${m.model}` : m.model;
      if (m.credits <= 0) continue;
      const k = `${date}\u0000${display}`;
      const agg = byDayModel.get(k) || { date, display, credits: 0, calls: 0, input: 0, output: 0, cacheRead: 0, billable: !thirdParty };
      agg.credits += m.credits;
      agg.calls += m.calls;
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      byDayModel.set(k, agg);
      sessionRows.push({ src: label, file: path.basename(f), date, display, credits: m.credits, calls: m.calls });
    }
  }
}

const n = (v) => Number(v || 0).toLocaleString("en-US");
const c = (v) => Number(v || 0).toFixed(2);

console.log(`\nAgent ledger from ${FROM} (source: usage.cost.total × 100)\n`);
console.log(`── Per day / model ─────────────────────────────────────`);
const rows = Array.from(byDayModel.values()).sort(
  (a, b) => a.date.localeCompare(b.date) || b.credits - a.credits
);
for (const r of rows) {
  console.log(
    `  ${r.date}  ${r.display.padEnd(44)} ${(r.billable ? "billable" : "NON-bill").padEnd(9)} ` +
      `calls=${String(r.calls).padStart(4)} credits=${c(r.credits).padStart(9)} ($${(r.credits / 100).toFixed(2)})  ` +
      `in=${n(r.input).padStart(10)} out=${n(r.output).padStart(9)} cacheRead=${n(r.cacheRead).padStart(12)}`
  );
}

console.log(`\n── Totals by model (non-billable only) ─────────────────`);
const byModel = new Map();
for (const r of rows) {
  if (r.billable) continue;
  const e = byModel.get(r.display) || { credits: 0, calls: 0, input: 0, output: 0, cacheRead: 0 };
  e.credits += r.credits;
  e.calls += r.calls;
  e.input += r.input;
  e.output += r.output;
  e.cacheRead += r.cacheRead;
  byModel.set(r.display, e);
}
let nbTotal = 0;
for (const [m, e] of Array.from(byModel.entries()).sort((a, b) => b[1].credits - a[1].credits)) {
  nbTotal += e.credits;
  console.log(
    `  ${m.padEnd(44)} calls=${String(e.calls).padStart(4)} credits=${c(e.credits).padStart(9)} ($${(e.credits / 100).toFixed(2)})  ` +
      `in=${n(e.input).padStart(10)} out=${n(e.output).padStart(9)} cacheRead=${n(e.cacheRead).padStart(12)}`
  );
}
console.log(`\n  NON-BILLABLE TOTAL = ${c(nbTotal)} credits  ($${(nbTotal / 100).toFixed(2)} real spend)`);
