/**
 * diagnose-nonano-sample.js — Compare attribute shape of a billed vs unbilled
 * September llm_request so the unbilled ones can be classified as BYOK or
 * Copilot-routed.
 */

const fs = require("fs");
const path = require("path");

const ROOT = "D:/vscode/workspaceStorage";
const CYCLE = "2026-09";

let billed = null;
let unbilled = [];

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

outer:
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
        if (!new Date(entry.ts).toISOString().startsWith(CYCLE)) { continue; }
        const a = entry.attrs;
        const nano = typeof a.copilotUsageNanoAiu === "number" ? a.copilotUsageNanoAiu : 0;
        const inp = typeof a.inputTokens === "number" ? a.inputTokens : 0;
        if (nano > 0 && !billed) {
          billed = { file, entry };
        } else if (nano === 0 && inp > 0 && unbilled.length < 3) {
          unbilled.push({ file, entry });
        }
        if (billed && unbilled.length >= 3) { break outer; }
      }
    }
  }
}

function show(label, rec) {
  console.log("=".repeat(70));
  console.log(label);
  console.log("  file: " + path.basename(path.dirname(rec.file)) + "/" + path.basename(rec.file));
  console.log("  ts  : " + new Date(rec.entry.ts).toISOString());
  console.log("  top-level keys: " + Object.keys(rec.entry).join(", "));
  console.log("  attrs:");
  for (const [k, v] of Object.entries(rec.entry.attrs)) {
    const s = typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "..." : JSON.stringify(v);
    console.log(`    ${k} = ${s}`);
  }
}

if (billed) { show("BILLED (has copilotUsageNanoAiu)", billed); }
for (const [i, u] of unbilled.entries()) { show(`UNBILLED sample #${i + 1}`, u); }
console.log("=".repeat(70));
