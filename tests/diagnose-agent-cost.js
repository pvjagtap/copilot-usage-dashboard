/**
 * diagnose-agent-cost.js — is `usage.cost.total` in OMP/Pi session logs
 * per-message or cumulative-per-session?
 *
 * agentScanner.ts SUMS it (`totalCostCredits += cost`). If the source emits a
 * running total, that sum is inflated triangularly and every non-billable
 * agent row in the dashboard is wrong.
 *
 * Usage: node tests/diagnose-agent-cost.js [--days 14] [--sessions 6]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
const DAYS = Number(arg("--days", 14));
const MAX_SESSIONS = Number(arg("--sessions", 6));

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

const cutoff = Date.now() - DAYS * 86400000;

for (const { label, dir } of roots) {
  console.log(`\n=== ${label.toUpperCase()}  ${dir}`);
  if (!fs.existsSync(dir)) {
    console.log("  (missing)");
    continue;
  }
  const files = walk(dir)
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .filter((x) => x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS);

  if (files.length === 0) {
    console.log(`  (no .jsonl modified in last ${DAYS} days)`);
    continue;
  }

  for (const { f, mtime } of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    const costs = [];
    let model = "";
    let provider = "";
    for (const line of lines) {
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
      const total = u.cost && typeof u.cost.total === "number" ? u.cost.total : null;
      if (total === null) continue;
      if (!model && typeof msg.model === "string") model = msg.model;
      if (!provider && typeof msg.provider === "string") provider = msg.provider;
      costs.push({ total, input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 });
    }
    if (costs.length === 0) continue;

    const sum = costs.reduce((s, x) => s + x.total, 0);
    const last = costs[costs.length - 1].total;
    const max = Math.max(...costs.map((x) => x.total));
    let monotonic = true;
    for (let i = 1; i < costs.length; i++) {
      if (costs[i].total < costs[i - 1].total) {
        monotonic = false;
        break;
      }
    }

    console.log(`\n  ${path.relative(dir, f)}`);
    console.log(`    modified   ${new Date(mtime).toISOString()}`);
    console.log(`    model      ${model}   provider=${provider || "(none)"}`);
    console.log(`    messages   ${costs.length} with usage.cost.total`);
    console.log(`    first 6    ${costs.slice(0, 6).map((x) => x.total.toFixed(6)).join("  ")}`);
    console.log(`    last 3     ${costs.slice(-3).map((x) => x.total.toFixed(6)).join("  ")}`);
    console.log(`    Σ total    $${sum.toFixed(4)}   → ${(sum * 100).toFixed(2)} credits  (what agentScanner reports)`);
    console.log(`    max total  $${max.toFixed(4)}   → ${(max * 100).toFixed(2)} credits  (correct if cumulative)`);
    console.log(`    last total $${last.toFixed(4)}`);
    console.log(
      `    VERDICT    ${monotonic && costs.length > 1 ? "*** NON-DECREASING → looks CUMULATIVE ***" : "varies up/down → looks PER-MESSAGE"}`
    );
    if (monotonic && costs.length > 1 && max > 0) {
      console.log(`    inflation  ${(sum / max).toFixed(1)}x`);
    }
  }
}
