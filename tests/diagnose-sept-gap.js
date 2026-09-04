/**
 * diagnose-sept-gap.js — Why does GitHub report more AIC than the dashboard?
 *
 * Reads every debug-log `llm_request` for the current cycle with NO token
 * filtering, so requests that carry `copilotUsageNanoAiu` but omit
 * inputTokens/outputTokens (error retries, tool-only rounds) are counted.
 * Both the scanner and verify-dashboard-vs-api.js skip those, so if any
 * exist they are a silent shared undercount rather than a real remote-only
 * charge.
 *
 *   node tests/diagnose-sept-gap.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CYCLE = process.argv[2] || "2026-09";

function candidateRoots() {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return [
    "D:/vscode/workspaceStorage",
    path.join(appData, "Code", "User", "workspaceStorage"),
    path.join(appData, "Code - Insiders", "User", "workspaceStorage"),
    path.join(appData, "VSCodium", "User", "workspaceStorage"),
    path.join(home, ".vscode-server", "data", "User", "workspaceStorage"),
    path.join(home, ".vscode-server-insiders", "data", "User", "workspaceStorage"),
  ];
}

function jsonlFilesFor(sessionDir) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(sessionDir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const full = path.join(sessionDir, entry.name);
    if (entry.isDirectory()) {
      const childMain = path.join(full, "main.jsonl");
      if (fs.existsSync(childMain)) files.push(childMain);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

const stats = {
  totalNano: 0,
  requests: 0,
  billedRequests: 0,
  zeroTokenNano: 0,
  zeroTokenRequests: 0,
  noNanoWithTokens: 0,
};
const byRoot = new Map();
const byModel = new Map();
const noNanoByKey = new Map();
const seenRoots = new Set();
let sessionDirs = 0;

for (const root of candidateRoots()) {
  let real;
  try { real = fs.realpathSync(root); } catch { continue; }
  if (seenRoots.has(real)) { continue; }
  seenRoots.add(real);

  let rootNano = 0;
  let rootRequests = 0;
  let workspaces;
  try { workspaces = fs.readdirSync(real); } catch { continue; }

  for (const ws of workspaces) {
    const debugLogs = path.join(real, ws, "GitHub.copilot-chat", "debug-logs");
    if (!fs.existsSync(debugLogs)) { continue; }
    let sessions;
    try { sessions = fs.readdirSync(debugLogs); } catch { continue; }

    for (const session of sessions) {
      const sessionDir = path.join(debugLogs, session);
      try { if (!fs.statSync(sessionDir).isDirectory()) { continue; } } catch { continue; }
      sessionDirs++;

      for (const file of jsonlFilesFor(sessionDir)) {
        let content;
        try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
        for (const line of content.split("\n")) {
          if (!line.trim()) { continue; }
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type !== "llm_request") { continue; }
          const attrs = entry.attrs;
          if (!attrs || typeof attrs !== "object") { continue; }
          if (typeof entry.ts !== "number") { continue; }
          if (!new Date(entry.ts).toISOString().startsWith(CYCLE)) { continue; }

          const nano = typeof attrs.copilotUsageNanoAiu === "number" ? attrs.copilotUsageNanoAiu : 0;
          const inp = typeof attrs.inputTokens === "number" ? attrs.inputTokens : 0;
          const out = typeof attrs.outputTokens === "number" ? attrs.outputTokens : 0;

          stats.requests++;
          stats.totalNano += nano;
          rootNano += nano;
          rootRequests++;

          if (nano > 0) { stats.billedRequests++; }
          if (inp === 0 && out === 0) {
            stats.zeroTokenRequests++;
            stats.zeroTokenNano += nano;
          }
          const model = (typeof attrs.model === "string" ? attrs.model : "unknown").toLowerCase();
          byModel.set(model, (byModel.get(model) ?? 0) + nano);

          if (nano === 0 && (inp > 0 || out > 0)) {
            stats.noNanoWithTokens++;
            const vendor = attrs.modelVendor ?? attrs.vendor ?? "?";
            const family = attrs.modelFamily ?? "?";
            const key = `${model} | vendor=${vendor} | family=${family}`;
            const prev = noNanoByKey.get(key) ?? { requests: 0, input: 0, output: 0 };
            prev.requests++;
            prev.input += inp;
            prev.output += out;
            noNanoByKey.set(key, prev);
          }
        }
      }
    }
  }

  if (rootRequests > 0) {
    byRoot.set(real, { credits: rootNano / 1e9, requests: rootRequests });
  }
}

const cr = n => (n / 1e9).toFixed(2);

console.log("=".repeat(70));
console.log(`Raw debug-log AIC for ${CYCLE} (no token filtering)`);
console.log("=".repeat(70));
console.log(`session dirs scanned      : ${sessionDirs}`);
console.log(`llm_requests in cycle     : ${stats.requests}`);
console.log(`  ...carrying nanoAiu > 0 : ${stats.billedRequests}`);
console.log(`  ...zero-token requests  : ${stats.zeroTokenRequests}`);
console.log(`  ...tokens but no nanoAiu: ${stats.noNanoWithTokens}`);
console.log("");
console.log(`TOTAL billed credits      : ${cr(stats.totalNano)}`);
console.log(`  of which zero-token     : ${cr(stats.zeroTokenNano)}  <-- skipped by scanner/audit if > 0`);

console.log("\nPer storage root:");
for (const [root, v] of byRoot) {
  console.log(`  ${v.credits.toFixed(2).padStart(10)} cr  ${String(v.requests).padStart(5)} req  ${root}`);
}

console.log("\nPer model:");
for (const [model, nano] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
  if (nano <= 0) { continue; }
  console.log(`  ${cr(nano).padStart(10)} cr  ${model}`);
}

console.log("\nRequests with tokens but NO billed credit (candidate blind spot):");
for (const [key, v] of [...noNanoByKey.entries()].sort((a, b) => b[1].requests - a[1].requests)) {
  const tokens = `${(v.input / 1e6).toFixed(2)}M in / ${(v.output / 1e3).toFixed(1)}k out`;
  console.log(`  ${String(v.requests).padStart(4)} req  ${tokens.padStart(24)}  ${key}`);
}
console.log("=".repeat(70));
