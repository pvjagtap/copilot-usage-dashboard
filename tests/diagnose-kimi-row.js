/**
 * diagnose-kimi-row.js — why does `kimi-azure/Kimi-K2.5` show 95.20 credits
 * when the agent ledger reports no cost for it?
 *
 * dashboardData.ts (agent block):
 *   const actualCredits = stats.costCredits > 0 ? stats.costCredits : usage.totalCredits;
 *
 * When the third-party provider reports no `usage.cost.total`, the credits
 * are ESTIMATED with the GitHub Copilot rate table — a price card that has
 * nothing to do with what the provider actually charged.
 *
 * Usage: node tests/diagnose-kimi-row.js <session.jsonl>
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};
const { AICCalculator } = require(path.join(ROOT, "out", "aicCredits.js"));

const file = process.argv[2];
if (!file) {
  console.error("usage: node tests/diagnose-kimi-row.js <session.jsonl>");
  process.exit(1);
}

const models = new Map();
for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = e && e.message;
  if (!msg || typeof msg !== "object") continue;
  const u = msg.usage;
  if (!u || typeof u !== "object") continue;
  const model = typeof msg.model === "string" ? msg.model : "unknown";
  const provider = typeof msg.provider === "string" ? msg.provider : "";
  const key = `${provider}\u0000${model}`;
  const m = models.get(key) || {
    model,
    provider,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costCredits: 0,
    calls: 0,
    costMsgs: 0,
  };
  m.input += u.input || 0;
  m.output += u.output || 0;
  m.cacheRead += u.cacheRead || 0;
  m.cacheWrite += u.cacheWrite || 0;
  if (u.cost && typeof u.cost.total === "number") {
    m.costCredits += u.cost.total * 100;
    if (u.cost.total > 0) m.costMsgs += 1;
  }
  m.calls += 1;
  models.set(key, m);
}

const calc = new AICCalculator();
const n = (v) => Number(v || 0).toLocaleString("en-US");

console.log(`\n${path.basename(file)}\n`);
for (const m of models.values()) {
  const gross = m.input + m.cacheRead + m.cacheWrite;
  const usage = calc.calculateCredits(m.model, gross, m.output, m.cacheRead, m.cacheWrite);
  const used = m.costCredits > 0 ? m.costCredits : usage.totalCredits;
  const p = m.provider.toLowerCase();
  const thirdParty = p.length > 0 && !(p.includes("github") || p.includes("copilot"));
  console.log(`  model      ${m.model}   provider=${m.provider || "(none)"}  thirdParty=${thirdParty}`);
  console.log(`  calls      ${m.calls}   messages with cost>0: ${m.costMsgs}`);
  console.log(
    `  tokens     input=${n(m.input)}  output=${n(m.output)}  cacheRead=${n(m.cacheRead)}  cacheWrite=${n(m.cacheWrite)}`
  );
  console.log(`  ledger     ${m.costCredits.toFixed(2)} credits  ($${(m.costCredits / 100).toFixed(2)})`);
  console.log(
    `  estimate   ${usage.totalCredits.toFixed(2)} credits  (rate model="${usage.model}", tier=${usage.tier})`
  );
  console.log(
    `  →  DASHBOARD USES ${used.toFixed(2)} credits  ${m.costCredits > 0 ? "(ledger — real)" : "*** (ESTIMATE — GitHub rate card applied to a non-GitHub model) ***"}`
  );
  console.log("");
}
