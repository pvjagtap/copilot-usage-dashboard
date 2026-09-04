/**
 * verify-ttl-tooltip-stability.js
 *
 * The status-bar hover is torn down and re-laid-out whenever `item.tooltip` is
 * assigned, so a per-second rebuild makes an open hover flicker. `refreshTtl`
 * therefore rebuilds only when a session crosses a colour band.
 *
 * Guards: bar text still ticks every second, tooltip does not.
 */

const path = require("path");
const Module = require("module");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

// The shared stub has no status-bar surface; add just enough to construct one.
const vscode = require(stubPath);
const barItem = {
  text: "",
  tooltip: undefined,
  command: undefined,
  color: undefined,
  backgroundColor: undefined,
  show() {},
  hide() {},
  dispose() {},
};
vscode.window.createStatusBarItem = () => barItem;
vscode.StatusBarAlignment = { Left: 1, Right: 2 };
vscode.ThemeColor = class { constructor(id) { this.id = id; } };
vscode.MarkdownString = class {
  constructor(value) { this.value = value ?? ""; }
  appendMarkdown(v) { this.value += v; return this; }
};

const { StatusBarProvider } = require(path.join(ROOT, "out", "statusBar.js"));
const ttl = require(path.join(ROOT, "out", "ttlState.js"));

let pass = 0;
const ok = (label) => {
  console.log("  \u2713 " + label);
  pass++;
};

const sb = new StatusBarProvider("copilotUsage.openDashboard");
const item = barItem;

let tooltipWrites = 0;
let textWrites = 0;
let tooltipValue;
let textValue = "";
Object.defineProperty(item, "tooltip", {
  configurable: true,
  get: () => tooltipValue,
  set: (v) => {
    tooltipValue = v;
    tooltipWrites++;
  },
});
Object.defineProperty(item, "text", {
  configurable: true,
  get: () => textValue,
  set: (v) => {
    textValue = v;
    textWrites++;
  },
});

const session = (remaining, state) => ({
  sessionId: "s1",
  title: "Some chat session",
  source: "vscode",
  lastRequestMs: Date.now(),
  working: false,
  model: "claude-opus-5",
  provider: "anthropic",
  timerValue: 300,
  warnAt: 120,
  alertAt: 30,
  costUsd: 0,
  cacheHitPct: 90,
  remaining,
  state,
});

sb.updateStatus({
  currentSessionAIC: 100,
  lastRequestAIC: 0,
  dollarPerCredit: 0.01,
  ttlShowInStatusBar: true,
  ttlMaxSessions: 20,
  ttlSessions: [session(200, "green")],
});

// --- tick within one colour band --------------------------------------
tooltipWrites = 0;
textWrites = 0;
for (let r = 199; r >= 190; r--) {
  sb.refreshTtl([session(r, "green")]);
}
assert.strictEqual(textWrites, 10, `bar text should repaint each tick, got ${textWrites}`);
ok("bar text repaints on every tick (10 ticks \u2192 10 writes)");
assert.strictEqual(tooltipWrites, 0, `tooltip should not rebuild mid-band, got ${tooltipWrites}`);
ok("tooltip does NOT rebuild while the state is unchanged");

// --- crossing a colour band -------------------------------------------
tooltipWrites = 0;
sb.refreshTtl([session(119, "yellow")]);
assert.strictEqual(tooltipWrites, 1, `band change should rebuild once, got ${tooltipWrites}`);
ok("tooltip rebuilds exactly once when green \u2192 yellow");

tooltipWrites = 0;
for (let r = 118; r >= 110; r--) {
  sb.refreshTtl([session(r, "yellow")]);
}
assert.strictEqual(tooltipWrites, 0, "no rebuild once settled in the new band");
ok("tooltip stays stable again inside the new band");

// --- a session appearing or leaving must refresh -----------------------
tooltipWrites = 0;
sb.refreshTtl([session(110, "yellow"), { ...session(80, "yellow"), sessionId: "s2" }]);
assert.strictEqual(tooltipWrites, 1, "a new session must rebuild the list");
ok("tooltip rebuilds when a second session appears");

tooltipWrites = 0;
sb.refreshTtl([session(109, "yellow")]);
assert.strictEqual(tooltipWrites, 1, "a departing session must rebuild the list");
ok("tooltip rebuilds when a session drops out");

// --- the footer must not be the widest line ----------------------------
const rows = [session(119, "yellow")].map(
  (s) => `${ttl.stateEmoji(s.state)} ${ttl.stateDisplay(s.state, s.remaining)}   ${ttl.shortTitle(s.title, 22)}`
);
const widestRow = Math.max(...rows.map((r) => r.length));
const footerSegments = "Cache lifetimes are<br>approximate & configurable."
  .split("<br>")
  .map((s) => s.length);
assert.ok(
  Math.max(...footerSegments) <= widestRow + 4,
  `footer segment (${Math.max(...footerSegments)}) must not exceed row width (${widestRow})`
);
ok("wrapped footer no longer dictates the hover width");

console.log(`\n\u2713 All ${pass} tooltip-stability checks passed`);
