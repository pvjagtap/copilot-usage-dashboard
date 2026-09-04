/**
 * diagnose-cycle-boundary.js — Test whether the constant dashboard-vs-GitHub
 * offset is late-Aug-31 usage that GitHub counts in September because its
 * billing cycle resets on the account's local timezone rather than UTC.
 *
 * Prints billed credits per hour across the Aug 31 / Sep 1 boundary and the
 * running total that each candidate cycle-start offset would add.
 */

const fs = require("fs");
const path = require("path");

const ROOT = "D:/vscode/workspaceStorage";

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

const events = [];

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
        const nano = typeof entry.attrs.copilotUsageNanoAiu === "number" ? entry.attrs.copilotUsageNanoAiu : 0;
        if (nano <= 0) { continue; }
        events.push({ ts: entry.ts, credits: nano / 1e9, model: entry.attrs.model });
      }
    }
  }
}

events.sort((a, b) => a.ts - b.ts);

const SEP1_UTC = Date.parse("2026-09-01T00:00:00Z");
const AUG31_START = Date.parse("2026-08-31T00:00:00Z");

console.log("=".repeat(72));
console.log("Billed credits per hour, Aug 31 -> Sep 1 boundary");
console.log("=".repeat(72));

const hourly = new Map();
for (const e of events) {
  if (e.ts < AUG31_START || e.ts >= SEP1_UTC) { continue; }
  const h = new Date(e.ts).toISOString().slice(0, 13);
  hourly.set(h, (hourly.get(h) ?? 0) + e.credits);
}
if (hourly.size === 0) {
  console.log("  (no billed requests logged on Aug 31)");
} else {
  for (const [h, v] of [...hourly.entries()].sort()) {
    console.log(`  ${h}Z  ${v.toFixed(2).padStart(9)} cr`);
  }
}

console.log("\nCredits GitHub would ADD to September for each cycle-start offset:");
const offsets = [
  ["UTC+14:00 (Kiritimati)", -14 * 60],
  ["UTC+10:00 (Sydney)", -10 * 60],
  ["UTC+09:00 (Tokyo)", -9 * 60],
  ["UTC+08:00 (Singapore)", -8 * 60],
  ["UTC+05:30 (India)", -5.5 * 60],
  ["UTC+02:00 (Berlin DST)", -2 * 60],
  ["UTC+01:00 (London DST)", -1 * 60],
  ["UTC+00:00 (UTC)", 0],
];
for (const [label, minutes] of offsets) {
  const boundary = SEP1_UTC + minutes * 60 * 1000;
  let sum = 0;
  for (const e of events) {
    if (e.ts >= boundary && e.ts < SEP1_UTC) { sum += e.credits; }
  }
  console.log(`  ${label.padEnd(24)} start=${new Date(boundary).toISOString()}  adds ${sum.toFixed(2)} cr`);
}

console.log("\nFirst 10 billed requests overall:");
for (const e of events.slice(0, 10)) {
  console.log(`  ${new Date(e.ts).toISOString()}  ${e.credits.toFixed(2).padStart(8)} cr  ${e.model}`);
}
console.log("=".repeat(72));
