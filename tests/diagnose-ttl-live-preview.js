/**
 * diagnose-ttl-live-preview.js — read-only.
 *
 * Renders exactly what the four TTL surfaces would show right now, using the
 * real scanner output and the same functions the extension calls. Lets us see
 * the feature without waiting on a window reload.
 *
 *   node tests/diagnose-ttl-live-preview.js
 */

const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const ttl = require(path.join(OUT, "ttlState.js"));
const prov = require(path.join(OUT, "ttlProviders.js"));
const { buildSidebarSnapshot } = require(path.join(OUT, "sidebarSnapshot.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

const DEFAULT_TTL_MAP = {
  anthropic: { timerValue: 300, warnAt: 120, alertAt: 30 },
  openai: { timerValue: 300, warnAt: 120, alertAt: 30 },
  google: { timerValue: 300, warnAt: 120, alertAt: 30 },
  xai: { timerValue: 300, warnAt: 120, alertAt: 30 },
  default: { timerValue: 300, warnAt: 120, alertAt: 30 },
};

(async () => {
  const scan = await scanWorkspaceStorage();
  const now = Date.now();

  // Mirror TtlTracker.ingest(): roll cached tokens up per session.
  const cachedBySession = new Map();
  for (const t of scan.turns ?? []) {
    if (t.debugCachedTokens > 0) {
      cachedBySession.set(t.sessionId, (cachedBySession.get(t.sessionId) ?? 0) + t.debugCachedTokens);
    }
  }
  const promptBySession = new Map();
  const creditBySession = new Map();
  for (const t of scan.turns ?? []) {
    promptBySession.set(t.sessionId, (promptBySession.get(t.sessionId) ?? 0) + (t.debugPromptTokens || 0));
    creditBySession.set(t.sessionId, (creditBySession.get(t.sessionId) ?? 0) + (t.debugAicCredits || 0));
  }

  const sessions = [];
  for (const s of scan.sessions) {
    if (!s.lastRequestMs) continue;
    const provider = prov.mapTtlProvider(s.lastRequestModel);
    const th = prov.getTtlThresholds(provider, DEFAULT_TTL_MAP);
    if (!ttl.isWithinActiveWindow(s.lastRequestMs, now, th.timerValue, 30)) continue;

    const working = ttl.computeWorking(
      { lastTurnStartMs: s.lastTurnStartMs, lastTurnEndMs: s.lastTurnEndMs, lastRequestMs: s.lastRequestMs },
      now, 5
    );
    const remaining = ttl.computeRemaining(th.timerValue, now, s.lastRequestMs);
    const state = ttl.computeState(working, remaining, th.warnAt, th.alertAt);
    const cached = cachedBySession.get(s.sessionId) ?? 0;
    const prompt = promptBySession.get(s.sessionId) ?? 0;

    sessions.push({
      sessionId: s.sessionId,
      title: ttl.shortTitle(s.sessionTitle || s.promptPreview || s.projectName || s.sessionId),
      source: "vscode",
      lastRequestMs: s.lastRequestMs,
      working,
      model: s.lastRequestModel,
      provider,
      timerValue: th.timerValue,
      warnAt: th.warnAt,
      alertAt: th.alertAt,
      costUsd: (creditBySession.get(s.sessionId) ?? 0) * 0.01,
      cacheHitPct: prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0,
      remaining,
      state,
    });
  }
  sessions.sort(ttl.urgencyCompare);

  const line = "=".repeat(76);
  console.log(line);
  console.log(`TTL LIVE PREVIEW  —  ${new Date(now).toLocaleTimeString()}`);
  console.log(line);
  console.log(`sessions scanned            : ${scan.sessions.length}`);
  console.log(`with TTL markers            : ${scan.sessions.filter(s => s.lastRequestMs).length}`);
  console.log(`warm right now (rendered)   : ${sessions.length}`);

  if (sessions.length === 0) {
    console.log("\n(nothing warm — every cache has lapsed. Send a chat turn and re-run.)");
    return;
  }

  console.log("\n" + "-".repeat(76));
  console.log("1. STATUS BAR");
  console.log("-".repeat(76));
  console.log(`   $(dashboard) …  •  ${ttl.aggregateText(sessions)}`);

  console.log("\n" + "-".repeat(76));
  console.log("2. STATUS-BAR TOOLTIP  →  Cache reuse");
  console.log("-".repeat(76));
  // Mirrors statusBar.ttlRowsMd() exactly, so widths here are the real widths.
  let widest = 0;
  for (const s of sessions.slice(0, 20)) {
    const left = `${ttl.stateEmoji(s.state)} ${ttl.stateDisplay(s.state, s.remaining)}`;
    const tag = s.source === "cli" ? "CLI  ·  " : "";
    const cost = s.costUsd > 0 ? `${tag}$${s.costUsd.toFixed(2)}` : tag.trim();
    const row = `${left}   ${ttl.shortTitle(s.title, 22)}${cost ? "   " + cost : ""}`;
    widest = Math.max(widest, row.length);
    console.log(`   ${row}`);
  }
  console.log("   Cache lifetimes are approximate and configurable.");
  console.log(`   [widest row: ${widest} chars — the hover stretches to this]`);

  console.log("\n" + "-".repeat(76));
  console.log("3. SIDEBAR  →  Cache Reuse card");
  console.log("-".repeat(76));
  const activationTime = new Date(now - 365 * 864e5).toISOString();
  const dashData = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, null, activationTime);
  const snap = buildSidebarSnapshot({
    dashData,
    scanTurns: scan.turns,
    liveStats: null,
    lastRequestAIC: 0,
    currentSessionAIC: 0,
    currentSessionModel: null,
    currentSessionTurns: 0,
    currentSessionDurationMin: 0,
    activationTime,
    ttlSessions: sessions,
  });
  if (snap.ttl && snap.ttl.lead) {
    const t = snap.ttl;
    console.log(`   lead        : ${t.lead.display}  (${t.lead.state})  ${t.lead.title}`);
    const filled = Math.round(t.lead.fraction * 40);
    console.log(`   progress    : [${"#".repeat(filled)}${"-".repeat(40 - filled)}] ${(t.lead.fraction * 100).toFixed(0)}%`);
    console.log(`   warm count  : ${t.warmCount}`);
    console.log(`   cache hit   : ${t.cacheHitPct}%`);
    for (const r of t.rows) {
      console.log(`     ${r.display.padEnd(8)} ${r.state.padEnd(7)} ${r.title}`);
    }
  } else {
    console.log("   (no lead session)");
  }

  console.log("\n" + "-".repeat(76));
  console.log("4. DASHBOARD  →  Sessions table, 'Cache TTL' column");
  console.log("-".repeat(76));
  console.log("   Session            Model                 Cache TTL");
  for (const s of sessions.slice(0, 10)) {
    console.log(
      `   ${s.sessionId.slice(0, 16).padEnd(18)} ${(s.model || "").padEnd(21)} ${ttl.stateDisplay(s.state, s.remaining)}`
    );
  }
  console.log("");
})();
