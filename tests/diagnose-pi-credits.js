/**
 * diagnose-pi-credits.js — reconcile the extension's "Pi" column against the
 * raw ~/.pi/agent/sessions JSONL files (the same bytes the Pi agent's own
 * usage tool reads).
 *
 *   node tests/diagnose-pi-credits.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));

const PI_ROOT = process.env.PI_CODING_AGENT_DIR
  ? path.join(process.env.PI_CODING_AGENT_DIR, "sessions")
  : path.join(os.homedir(), ".pi", "agent", "sessions");

const n = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function walk(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

async function main() {
  console.log("Pi sessions root: " + PI_ROOT);
  if (!fs.existsSync(PI_ROOT)) { console.error("! not found"); process.exit(1); }

  const files = walk(PI_ROOT);
  console.log(`jsonl files: ${files.length}\n`);

  // ── Raw pass: every assistant message with a usage block ──
  const byMonth = new Map();
  const costKeys = new Map();          // which numeric fields live under usage.cost
  const usageKeys = new Map();         // which numeric fields live under usage
  const providers = new Map();
  let noCost = 0, withCost = 0;

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      const u = m.usage;

      Object.keys(u).forEach(k => usageKeys.set(k, (usageKeys.get(k) || 0) + 1));
      if (u.cost && typeof u.cost === "object") {
        Object.keys(u.cost).forEach(k => costKeys.set(k, (costKeys.get(k) || 0) + 1));
      }
      providers.set(m.provider || "(none)", (providers.get(m.provider || "(none)") || 0) + 1);

      const ts = typeof m.timestamp === "number" ? m.timestamp
        : e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (!ts) continue;
      const month = new Date(ts).toISOString().slice(0, 7);

      const row = byMonth.get(month) || { calls: 0, costUsd: 0, premium: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() };
      row.calls++;
      row.sessions.add(f);
      row.input += u.input || 0;
      row.output += u.output || 0;
      row.cacheRead += u.cacheRead || 0;
      row.cacheWrite += u.cacheWrite || 0;
      row.premium += u.premiumRequests || 0;
      if (u.cost && typeof u.cost.total === "number") { row.costUsd += u.cost.total; withCost++; }
      else { noCost++; }
      byMonth.set(month, row);
    }
  }

  console.log("usage.* fields seen   :", [...usageKeys.entries()].map(([k, c]) => `${k}(${c})`).join(" "));
  console.log("usage.cost.* fields   :", [...costKeys.entries()].map(([k, c]) => `${k}(${c})`).join(" "));
  console.log("providers             :", [...providers.entries()].map(([k, c]) => `${k}(${c})`).join(" "));
  console.log(`assistant msgs with usage.cost.total: ${withCost}   without: ${noCost}\n`);

  console.log("RAW ~/.pi files, per month");
  console.log("month     sessions  calls      cost USD    credits(=USD*100)  premiumReqs   tokens");
  [...byMonth.entries()].sort().forEach(([mo, r]) => {
    const tok = r.input + r.output + r.cacheRead + r.cacheWrite;
    console.log(
      `${mo}   ${String(r.sessions.size).padStart(6)}  ${String(r.calls).padStart(6)}  ${n(r.costUsd).padStart(11)}  ${n(r.costUsd * 100).padStart(16)}  ${n(r.premium).padStart(11)}  ${n(tok).padStart(12)}`
    );
  });

  // Per-message-timestamp truth for the current month, split by provider —
  // apples-to-apples with the Pi agent's own Providers tab.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const byProv = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      const ts = typeof m.timestamp === "number" ? m.timestamp
        : e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (!ts || new Date(ts).toISOString().slice(0, 7) !== thisMonth) continue;
      const p = m.provider || "(none)";
      const row = byProv.get(p) || { calls: 0, usd: 0, sessions: new Set() };
      row.calls++;
      row.usd += (m.usage.cost && typeof m.usage.cost.total === "number") ? m.usage.cost.total : 0;
      row.sessions.add(f);
      byProv.set(p, row);
    }
  }
  console.log(`\nRAW, ${thisMonth} only, by MESSAGE timestamp (matches Pi 'Providers' tab)`);
  [...byProv.entries()].sort((a, b) => b[1].usd - a[1].usd).forEach(([p, r]) =>
    console.log(`  ${n(r.usd * 100).padStart(12)} cr  $${n(r.usd).padStart(8)}  ${String(r.calls).padStart(5)} calls  ${String(r.sessions.size).padStart(3)} sess  ${p}`));

  // ── What the extension's own scanner produces ──
  const scan = await scanAgentSessions();
  const pi = scan.sessions.filter(s => s.source === "pi");
  const piCost = pi.reduce((a, s) => a + s.totalCostCredits, 0);
  const piCalls = pi.reduce((a, s) => a + s.llmCalls, 0);
  const piTok = pi.reduce((a, s) => a + s.totalTokens, 0);

  console.log("\nEXTENSION agentScanner (billing period only)");
  console.log(`  billingStart      : ${new Date(scan.billingStart).toISOString().slice(0, 10)}`);
  console.log(`  pi sessions       : ${pi.length}`);
  console.log(`  pi llmCalls       : ${n(piCalls)}`);
  console.log(`  pi tokens         : ${n(piTok)}`);
  console.log(`  pi costCredits    : ${n(piCost)}`);
  console.log(`  piAllTimeSessions : ${scan.piAllTimeSessions}  calls=${n(scan.piAllTimeLlmCalls)}  tokens=${n(scan.piAllTimeTokens)}`);

  // Provider classification is what decides billable vs not in dashboardData.
  const provCount = new Map();
  for (const s of pi) {
    for (const [model, st] of Object.entries(s.modelBreakdown)) {
      const p = (st.provider || s.provider || "").toLowerCase() || "(none)";
      const key = `${p} :: ${model}`;
      const row = provCount.get(key) || { credits: 0, calls: 0 };
      row.credits += st.costCredits;
      row.calls += st.llmCalls;
      provCount.set(key, row);
    }
  }
  console.log("\n  per provider::model (billing period)");
  [...provCount.entries()].sort((a, b) => b[1].credits - a[1].credits).forEach(([k, v]) => {
    const p = k.split(" :: ")[0];
    const thirdParty = p !== "(none)" && !p.includes("github") && !p.includes("copilot");
    console.log(`    ${n(v.credits).padStart(12)} cr  ${String(v.calls).padStart(5)} calls  ${k}${thirdParty ? "   <-- classified NON-BILLABLE" : ""}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
