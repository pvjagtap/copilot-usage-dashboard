/**
 * verify-ttl-from-scan.js
 *
 * The TTL subsystem is deliberately data-only: it performs no I/O of its own
 * and derives every countdown from fields the existing scanner already fills.
 * Two things therefore have to hold, and neither is visible from a unit test
 * of `ttlState.ts` alone:
 *
 *   A. The scanner actually captures `lastTurnStartMs`, `lastTurnEndMs`,
 *      `lastRequestMs` and `lastRequestModel` from a real debug-log directory,
 *      including the newest-wins merge across child (subagent / title) logs.
 *
 *   B. Those fields are additive. They must not perturb ANY token or credit
 *      total — the entire value of this extension rests on those numbers, and
 *      a TTL feature is not worth one cent of drift.
 *
 * This builds a synthetic-but-shaped debug-log tree on disk, scans it through
 * the real `parseDebugLogDir`, and asserts both.
 *
 * Run after compile:
 *   node tests/verify-ttl-from-scan.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(
    stubPath,
    "module.exports = { workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) }, window: {}, commands: {}, Uri: { file: (p) => ({ fsPath: p, toString: () => p }) }, ConfigurationTarget: { Global: 1 }, EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} } };\n"
  );
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const scanner = require(path.join(OUT, "scanner.js"));
const ttl = require(path.join(OUT, "ttlState.js"));

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ""}`);
    failed++;
  }
}

// ── Build a debug-log tree that mirrors the real on-disk shape ──
const BASE = 1_800_000_000_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cu-ttl-"));
const sid = "11111111-2222-3333-4444-555555555555";
const dir = path.join(tmp, sid);
fs.mkdirSync(dir, { recursive: true });

const line = (o) => JSON.stringify(o) + "\n";
const req = (ts, model, input, output, cached) =>
  line({
    ts,
    type: "llm_request",
    attrs: { model, inputTokens: input, outputTokens: output, cachedTokens: cached, copilotUsageNanoAiu: 1_000_000 },
  });

// main.jsonl: two closed turns, then a THIRD turn that is still open.
fs.writeFileSync(
  path.join(dir, "main.jsonl"),
  line({ ts: BASE - 610_000, type: "session_start", sid }) +
    line({ ts: BASE - 600_000, type: "turn_start", attrs: { turnId: 0 } }) +
    req(BASE - 599_000, "claude-opus-5", 1000, 200, 0) +
    line({ ts: BASE - 580_000, type: "turn_end", attrs: { turnId: 0 } }) +
    line({ ts: BASE - 300_000, type: "turn_start", attrs: { turnId: 1 } }) +
    req(BASE - 299_000, "claude-opus-5", 4000, 300, 900) +
    line({ ts: BASE - 280_000, type: "turn_end", attrs: { turnId: 1 } }) +
    line({ ts: BASE - 60_000, type: "turn_start", attrs: { turnId: 2 } }) +
    req(BASE - 59_000, "claude-opus-5", 6000, 400, 3800)
);

// An orphan subagent log whose newest request is NEWER than main's. It shares
// the same prompt cache, so it must win the TTL anchor.
fs.writeFileSync(
  path.join(dir, "runSubagent-1.jsonl"),
  line({ ts: BASE - 22_000, type: "session_start", sid: `${sid}-sub` }) +
    line({ ts: BASE - 21_000, type: "turn_start", attrs: { turnId: 0 } }) +
    req(BASE - 20_000, "claude-haiku-4.5", 500, 80, 0)
);

main().catch((e) => {
  console.log(`  \u2717 unexpected failure \u2014 ${e && e.stack}`);
  process.exit(1);
});

async function main() {
const parsed = await scanner.parseDebugLogDir(dir);
if (!parsed) {
  console.log("  \u2717 parseDebugLogDir returned null for a valid fixture");
  process.exit(1);
}

console.log("== Test 1: TTL markers are captured from a real debug-log tree ==");
ok(
  "lastTurnStartMs is the newest turn_start",
  parsed.lastTurnStartMs === BASE - 60_000,
  String(parsed.lastTurnStartMs)
);
ok(
  "lastTurnEndMs is the newest turn_end (the open turn has none)",
  parsed.lastTurnEndMs === BASE - 280_000,
  String(parsed.lastTurnEndMs)
);
ok(
  "lastRequestMs takes the newest request across main + child",
  parsed.lastRequestMs === BASE - 20_000,
  String(parsed.lastRequestMs)
);
ok(
  "lastRequestModel follows that newest request",
  parsed.lastRequestModel === "claude-haiku-4.5",
  parsed.lastRequestModel
);

console.log("\n== Test 2: an open turn reads as HOT ==");
const marks = {
  lastTurnStartMs: parsed.lastTurnStartMs,
  lastTurnEndMs: parsed.lastTurnEndMs,
  lastRequestMs: parsed.lastRequestMs,
};
ok("turn_start > turn_end \u2192 working", ttl.computeWorking(marks, BASE, 5) === true);
ok(
  "and therefore HOT regardless of the clock",
  ttl.computeState(true, ttl.computeRemaining(300, BASE, parsed.lastRequestMs), 120, 30) === "hot"
);

console.log("\n== Test 3: closing the turn hands control back to the countdown ==");
fs.appendFileSync(path.join(dir, "main.jsonl"), line({ ts: BASE - 10_000, type: "turn_end", attrs: { turnId: 2 } }));
const closed = await scanner.parseDebugLogDir(dir);
ok("lastTurnEndMs advances past lastTurnStartMs", closed.lastTurnEndMs === BASE - 10_000, String(closed.lastTurnEndMs));
ok(
  "no longer working",
  ttl.computeWorking(
    {
      lastTurnStartMs: closed.lastTurnStartMs,
      lastTurnEndMs: closed.lastTurnEndMs,
      lastRequestMs: closed.lastRequestMs,
    },
    BASE,
    5
  ) === false
);
const remaining = ttl.computeRemaining(300, BASE, closed.lastRequestMs);
ok("countdown reflects 20s since the last request", remaining === 280, String(remaining));
ok("which is still green", ttl.computeState(false, remaining, 120, 30) === "green");

console.log("\n== Test 4: TTL markers do not disturb token or credit totals ==");
// 1000+4000+6000+500 prompt, 200+300+400+80 output, 0+900+3800+0 cached,
// 4 requests * 1_000_000 nanoAiu = 0.004 AIC.
const sum = (key) => (parsed.requests || []).reduce((a, r) => a + (r[key] || 0), 0);
ok("4 requests parsed (main + orphan child)", (parsed.requests || []).length === 4, String((parsed.requests || []).length));
ok("prompt tokens total 11500", parsed.totalPrompt === 11500, String(parsed.totalPrompt));
ok("output tokens total 980", parsed.totalOutput === 980, String(parsed.totalOutput));
ok("cached tokens total 4700", sum("cached") === 4700, String(sum("cached")));
ok("llm call count is 4", parsed.totalLlmCalls === 4, String(parsed.totalLlmCalls));
ok("nanoAiu totals 4_000_000 (0.004 AIC)", parsed.totalNanoAiu === 4_000_000, String(parsed.totalNanoAiu));
ok(
  "no timestamp leaked into a token sum",
  parsed.totalPrompt + parsed.totalOutput + parsed.totalNanoAiu < BASE,
  "a TTL marker was summed as usage"
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  failed === 0
    ? "\n\u2713 All TTL-from-scan checks passed"
    : `\n\u2717 ${failed} TTL-from-scan check(s) failed`
);
process.exit(failed === 0 ? 0 : 1);
}
