/**
 * verify-cache-ttl.js
 *
 * Pins the prompt-cache TTL subsystem introduced alongside the cache-timer
 * integration:
 *
 *   1. State machine  — hot / green / yellow / red / cold boundaries.
 *   2. Threshold map  — provider → default → built-in fallback, with the
 *                       `alertAt <= warnAt <= timerValue` clamp that the state
 *                       machine assumes but does not itself enforce.
 *   3. Provider map   — catalog vendor wins, regex is the fallback, generic
 *                       vendors ("copilot", "multiple") never leak through as
 *                       a cache provider.
 *   4. Alert gating   — the sound fires exactly once per entry into red, and
 *                       re-arms only after a genuinely newer request.
 *   5. Sound safety   — the Windows player never interpolates the user's path
 *                       into the PowerShell command, and bad paths fall back
 *                       to the bundled asset.
 *   6. Formatting     — M:SS / H:MM:SS, and the aggregate status-bar segment.
 *
 * Run after compile:
 *   node tests/verify-cache-ttl.js
 */

const path = require("path");
const fs = require("fs");
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

const ttl = require(path.join(OUT, "ttlState.js"));
const providers = require(path.join(OUT, "ttlProviders.js"));
const sound = require(path.join(OUT, "ttlSound.js"));

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ""}`);
    failed++;
  }
}

// ── 1. State machine ────────────────────────────────────────
console.log("== Test 1: state machine boundaries (timer 300 / warn 120 / alert 30) ==");
const T = { timerValue: 300, warnAt: 120, alertAt: 30 };
for (const [remaining, working, expect] of [
  [300, false, "green"],
  [121, false, "green"],
  [120, false, "yellow"], // inclusive upper edge of yellow
  [31, false, "yellow"],
  [30, false, "red"], // inclusive upper edge of red
  [0.5, false, "red"],
  [0, false, "cold"], // inclusive: 0 is already expired
  [-42, false, "cold"],
  [10, true, "hot"], // working always wins, even deep into red
  [-999, true, "hot"], // ...and even past expiry
]) {
  const got = ttl.computeState(working, remaining, T.warnAt, T.alertAt);
  ok(`remaining=${remaining} working=${working} \u2192 ${expect}`, got === expect, got);
}

console.log("\n== Test 2: computeRemaining counts down in real seconds ==");
const now = 1_800_000_000_000;
ok("no elapsed time \u2192 full lifetime", ttl.computeRemaining(300, now, now) === 300);
ok("90s elapsed \u2192 210 left", ttl.computeRemaining(300, now, now - 90_000) === 210);
ok("goes negative past expiry", ttl.computeRemaining(300, now, now - 400_000) === -100);

console.log("\n== Test 3: computeWorking (HOT) ==");
ok(
  "open turn (start > end) is working",
  ttl.computeWorking({ lastTurnStartMs: now - 5000, lastTurnEndMs: now - 60_000, lastRequestMs: now }, now, 5) === true
);
ok(
  "closed turn (end > start) is NOT working",
  ttl.computeWorking({ lastTurnStartMs: now - 60_000, lastTurnEndMs: now - 5000, lastRequestMs: now }, now, 5) === false
);
ok(
  "no markers + recent request \u2192 grace window applies (CLI path)",
  ttl.computeWorking({ lastTurnStartMs: 0, lastTurnEndMs: 0, lastRequestMs: now - 2000 }, now, 5) === true
);
ok(
  "no markers + old request \u2192 not working",
  ttl.computeWorking({ lastTurnStartMs: 0, lastTurnEndMs: 0, lastRequestMs: now - 20_000 }, now, 5) === false
);
ok(
  "a closed turn is not resurrected by the grace window",
  ttl.computeWorking({ lastTurnStartMs: now - 60_000, lastTurnEndMs: now - 1000, lastRequestMs: now }, now, 5) === false
);

console.log("\n== Test 4: active window (timerValue + grace) ==");
ok("fresh request is in-window", ttl.isWithinActiveWindow(now - 1000, now, 300, 30) === true);
ok("inside the grace tail is in-window", ttl.isWithinActiveWindow(now - 320_000, now, 300, 30) === true);
ok("past the grace tail is out", ttl.isWithinActiveWindow(now - 340_000, now, 300, 30) === false);
ok("a session with no request anchor is out", ttl.isWithinActiveWindow(0, now, 300, 30) === false);

// ── 5. Threshold resolution ─────────────────────────────────
console.log("\n== Test 5: threshold resolution + clamping ==");
const map = {
  anthropic: { timerValue: 600, warnAt: 300, alertAt: 60 },
  default: { timerValue: 120 },
};
const anth = providers.getTtlThresholds("anthropic", map);
ok("provider entry wins", anth.timerValue === 600 && anth.warnAt === 300 && anth.alertAt === 60, JSON.stringify(anth));

const openai = providers.getTtlThresholds("openai", map);
ok("falls back to the `default` entry for timerValue", openai.timerValue === 120, JSON.stringify(openai));
ok(
  "warnAt clamps down to timerValue when default is smaller",
  openai.warnAt === 120,
  JSON.stringify(openai)
);
ok("alertAt stays <= warnAt", openai.alertAt <= openai.warnAt, JSON.stringify(openai));

const built = providers.getTtlThresholds("unknown-vendor", {});
ok(
  "empty map \u2192 built-in 300/120/30",
  built.timerValue === 300 && built.warnAt === 120 && built.alertAt === 30,
  JSON.stringify(built)
);

const junk = providers.getTtlThresholds("openai", { openai: { timerValue: 0, warnAt: -5, alertAt: "abc" } });
ok(
  "junk values fall back instead of producing a broken ladder",
  junk.timerValue === 300 && junk.warnAt === 120 && junk.alertAt === 30,
  JSON.stringify(junk)
);

const inverted = providers.getTtlThresholds("x", { x: { timerValue: 60, warnAt: 500, alertAt: 400 } });
ok(
  "inverted config is clamped to alertAt <= warnAt <= timerValue",
  inverted.alertAt <= inverted.warnAt && inverted.warnAt <= inverted.timerValue,
  JSON.stringify(inverted)
);

ok("maxTimerValue spans the whole map", providers.maxTimerValue(map) === 600, String(providers.maxTimerValue(map)));

// ── 6. Provider mapping ─────────────────────────────────────
console.log("\n== Test 6: model \u2192 cache provider ==");
// The catalog is empty in this harness, so these exercise the regex fallback —
// which is precisely the path BYOK and brand-new model ids take in the wild.
for (const [model, expect] of [
  ["claude-opus-5", "anthropic"],
  ["claude-haiku-4.5", "anthropic"],
  ["gpt-5.3-codex", "openai"],
  ["gpt-4o-mini-2024-07-18", "openai"],
  ["o3-mini", "openai"],
  ["gemini-3.6-flash", "google"],
  ["grok-4.5", "xai"],
  ["some-unheard-of-model", "default"],
  ["", "default"],
  [undefined, "default"],
]) {
  const got = providers.mapTtlProvider(model);
  ok(`${JSON.stringify(model)} \u2192 ${expect}`, got === expect, got);
}
ok(
  "an explicit vendor hint is used when the id is unrecognised",
  providers.mapTtlProvider("mystery-model", "mistral") === "mistral"
);
ok(
  "a generic vendor hint never becomes a cache provider",
  providers.mapTtlProvider("mystery-model", "copilot") === "default"
);
ok(
  "the regex beats a generic hint",
  providers.mapTtlProvider("claude-opus-5", "copilot") === "anthropic"
);

// ── 7. Alert gating ─────────────────────────────────────────
console.log("\n== Test 7: alert gating fires once per entry into red ==");
const opts = { soundEnabled: true, notifyOnRed: true };
ok("yellow \u2192 red fires", ttl.alertDecision("yellow", "red", opts).playSound === true);
ok("red \u2192 red does NOT re-fire", ttl.alertDecision("red", "red", opts).playSound === false);
ok("red \u2192 cold does not fire", ttl.alertDecision("red", "cold", opts).playSound === false);
ok("first sighting already red fires", ttl.alertDecision(undefined, "red", opts).playSound === true);
ok(
  "soundEnabled=false suppresses sound but not the notification",
  ttl.alertDecision("yellow", "red", { soundEnabled: false, notifyOnRed: true }).playSound === false &&
    ttl.alertDecision("yellow", "red", { soundEnabled: false, notifyOnRed: true }).notify === true
);
ok(
  "both off \u2192 silent",
  ttl.alertDecision("yellow", "red", { soundEnabled: false, notifyOnRed: false }).playSound === false &&
    ttl.alertDecision("yellow", "red", { soundEnabled: false, notifyOnRed: false }).notify === false
);

// ── 8. Sound safety ─────────────────────────────────────────
console.log("\n== Test 8: sound path handling is injection-safe ==");
const evil = "C:\\tmp\\a'; Start-Process calc.exe; '.wav";
const win = sound.buildPlayerCommand("win32", evil);
ok("windows uses powershell with an args array", win && win.cmd === "powershell" && Array.isArray(win.args));
ok(
  "the sound path never appears inside the -Command string",
  win && !win.args.join(" ").includes("Start-Process") && !win.args.join(" ").includes(evil),
  win && win.args.join(" ")
);
ok("the path is passed through the environment instead", win && win.env && win.env[sound.WIN_SOUND_ENV] === evil);
ok("darwin uses afplay with the path as a separate arg", (() => {
  const d = sound.buildPlayerCommand("darwin", evil);
  return d && d.cmd === "afplay" && d.args.length === 1 && d.args[0] === evil;
})());
ok("unsupported platform yields no command", sound.buildPlayerCommand("aix", evil) === undefined);

const bundled = path.join(ROOT, "media", "alert.wav");
ok("bundled alert.wav is present for packaging", fs.existsSync(bundled), bundled);
ok("empty override \u2192 bundled asset", sound.resolveSoundPath("", bundled) === bundled);
ok("relative path is rejected", sound.resolveSoundPath("alert.wav", bundled) === bundled);
ok("missing file is rejected", sound.resolveSoundPath(path.join(ROOT, "nope.wav"), bundled) === bundled);
ok(
  "wrong extension is rejected even when the file exists",
  sound.resolveSoundPath(path.join(ROOT, "package.json"), bundled) === bundled
);
ok("a valid absolute path is honoured", sound.resolveSoundPath(bundled, bundled) === bundled);

// ── 9. Formatting + ordering ────────────────────────────────
console.log("\n== Test 9: formatting and urgency ordering ==");
ok("0 \u2192 0:00", ttl.formatTtl(0) === "0:00", ttl.formatTtl(0));
ok("negative clamps to 0:00", ttl.formatTtl(-30) === "0:00", ttl.formatTtl(-30));
ok("45 \u2192 0:45", ttl.formatTtl(45) === "0:45", ttl.formatTtl(45));
ok("135 \u2192 2:15", ttl.formatTtl(135) === "2:15", ttl.formatTtl(135));
ok("3661 \u2192 1:01:01", ttl.formatTtl(3661) === "1:01:01", ttl.formatTtl(3661));
ok("hot renders HOT, not a countdown", ttl.stateDisplay("hot", 240) === "HOT");
ok("cold renders COLD", ttl.stateDisplay("cold", -5) === "COLD");

const mk = (state, remaining) => ({
  sessionId: state,
  title: state,
  source: "vscode",
  lastRequestMs: now,
  working: state === "hot",
  model: "m",
  provider: "p",
  timerValue: 300,
  warnAt: 120,
  alertAt: 30,
  costUsd: 0,
  cacheHitPct: 0,
  remaining,
  state,
});
const sorted = [mk("cold", -10), mk("hot", 300), mk("green", 250), mk("red", 12), mk("yellow", 90)].sort(
  ttl.urgencyCompare
);
ok(
  "urgency order is red, yellow, green, hot, cold",
  sorted.map(s => s.state).join(",") === "red,yellow,green,hot,cold",
  sorted.map(s => s.state).join(",")
);
const tie = [mk("red", 25), mk("red", 5)].sort(ttl.urgencyCompare);
ok("ties break on the shorter countdown first", tie[0].remaining === 5);

ok("empty list yields no status-bar segment", ttl.aggregateText([]) === "");
ok(
  "single session shows emoji + countdown with no count",
  ttl.aggregateText([mk("yellow", 135)]) === "\u{1F7E1} 2:15",
  ttl.aggregateText([mk("yellow", 135)])
);
ok(
  "multiple sessions append a count",
  ttl.aggregateText(sorted) === "\u{1F534} 0:12 (5)",
  ttl.aggregateText(sorted)
);

console.log(
  failed === 0
    ? "\n\u2713 All cache-TTL checks passed"
    : `\n\u2717 ${failed} cache-TTL check(s) failed`
);
process.exit(failed === 0 ? 0 : 1);
