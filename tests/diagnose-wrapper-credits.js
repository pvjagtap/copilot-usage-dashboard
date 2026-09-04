/**
 * diagnose-wrapper-credits.js — Estimate the credit value of September
 * `copilotLanguageModelWrapper` requests that carry tokens but no
 * `copilotUsageNanoAiu`, to test whether they account for the observed
 * dashboard-vs-GitHub gap.
 */

const path = require("path");
const fs = require("fs");

const Module = require("module");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") { return stubPath; }
  return origResolve.call(this, request, parent, ...rest);
};

const OUT = path.join(__dirname, "..", "out");
const { DEFAULT_AIC_CONFIG, createCalculatorFromConfig } = require(path.join(OUT, "aicCredits.js"));

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const ROOT = "D:/vscode/workspaceStorage";
const CYCLE = "2026-09";

function jsonlFilesFor(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const m = path.join(full, "main.jsonl");
      if (fs.existsSync(m)) { out.push(m); }
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

const rows = [];
let billedCredits = 0;

for (const ws of fs.readdirSync(ROOT)) {
  const debugLogs = path.join(ROOT, ws, "GitHub.copilot-chat", "debug-logs");
  if (!fs.existsSync(debugLogs)) { continue; }
  for (const session of fs.readdirSync(debugLogs)) {
    const dir = path.join(debugLogs, session);
    try { if (!fs.statSync(dir).isDirectory()) { continue; } } catch { continue; }
    for (const file of jsonlFilesFor(dir)) {
      let content;
      try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
      for (const line of content.split("\n")) {
        if (!line.trim()) { continue; }
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== "llm_request" || !entry.attrs) { continue; }
        if (typeof entry.ts !== "number") { continue; }
        const iso = new Date(entry.ts).toISOString();
        if (!iso.startsWith(CYCLE)) { continue; }
        const a = entry.attrs;
        const nano = typeof a.copilotUsageNanoAiu === "number" ? a.copilotUsageNanoAiu : 0;
        if (nano > 0) { billedCredits += nano / 1e9; continue; }
        const inp = typeof a.inputTokens === "number" ? a.inputTokens : 0;
        const out = typeof a.outputTokens === "number" ? a.outputTokens : 0;
        const cached = typeof a.cachedTokens === "number" ? a.cachedTokens : 0;
        if (inp === 0 && out === 0) { continue; }
        const est = calc.calculateCredits(a.model || "unknown", inp, out, cached, 0).totalCredits;
        rows.push({ iso, debugName: a.debugName || "?", model: a.model || "?", est });
      }
    }
  }
}

rows.sort((x, y) => x.iso.localeCompare(y.iso));

const byDebugName = new Map();
for (const r of rows) {
  const prev = byDebugName.get(r.debugName) ?? { requests: 0, credits: 0 };
  prev.requests++;
  prev.credits += r.est;
  byDebugName.set(r.debugName, prev);
}

const totalEst = rows.reduce((s, r) => s + r.est, 0);

console.log("=".repeat(72));
console.log("September requests with tokens but NO copilotUsageNanoAiu");
console.log("=".repeat(72));
console.log(`billed credits already counted : ${billedCredits.toFixed(2)}`);
console.log(`unbilled requests              : ${rows.length}`);
console.log(`estimated value of unbilled     : ${totalEst.toFixed(2)} credits`);
console.log("\nBy debugName:");
for (const [name, v] of [...byDebugName.entries()].sort((a, b) => b[1].credits - a[1].credits)) {
  console.log(`  ${v.credits.toFixed(2).padStart(10)} cr  ${String(v.requests).padStart(4)} req  ${name}`);
}

console.log("\nCumulative unbilled estimate over time (hourly):");
const hours = new Map();
let run = 0;
for (const r of rows) {
  run += r.est;
  hours.set(r.iso.slice(0, 13), run);
}
for (const [h, v] of hours) { console.log(`  ${h}Z  ${v.toFixed(2)}`); }
console.log("=".repeat(72));
