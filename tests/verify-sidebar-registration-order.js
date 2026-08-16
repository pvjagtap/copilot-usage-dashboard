/**
 * verify-sidebar-registration-order.js — the Activity Bar webview provider
 * must be registered before activate() awaits anything.
 *
 * Regression: registerWebviewViewProvider("copilotUsage.panel", …) sat ~180
 * lines into `async activate()`, behind `await runScan()` (a full scan of
 * every workspaceStorage chat session), `await receiver.start()` and up to
 * four `await config.update(…)` global settings writes. VS Code resolves a
 * `type: "webview"` view at window load; with no provider registered yet the
 * view renders permanently blank, and nothing surfaces the failure.
 *
 * Only awaits in activate's OWN body count — ones nested inside callbacks
 * (e.g. the refresh command handler) run later and are harmless.
 *
 *   node tests/verify-sidebar-registration-order.js
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.resolve(__dirname, "..", "out", "extension.js"), "utf8");

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

const sigAt = src.indexOf("async function activate(");
assert("activate() found in compiled output", sigAt !== -1);
if (sigAt === -1) process.exit(1);

const bodyStart = src.indexOf("{", sigAt) + 1;
const WANT = ["registerWebviewViewProvider", "setOnReady"];

// Walk activate's body skipping strings / template literals / comments, so a
// comment containing the word "await" cannot trip the guard. Records the first
// `await` at brace depth 0 (activate's own statements) and where each sidebar
// wiring call appears.
function scan(text, from) {
  let depth = 0;
  let firstTopAwait = -1;
  const marks = {};
  const topRunScan = [];

  for (let i = from; i < text.length; i++) {
    const c = text[i];
    const two = text.slice(i, i + 2);

    if (two === "//") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (two === "/*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? text.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { i++; }
        i++;
      }
      continue;
    }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth < 0) { return { firstTopAwait, marks, topRunScan }; }
      continue;
    }
    if (depth === 0 && text.startsWith("runScan(", i) && !/[\w$.]/.test(text[i - 1] || "")) {
      topRunScan.push(i);
    }
    if (depth === 0 && firstTopAwait === -1 && text.startsWith("await ", i) && !/[\w$]/.test(text[i - 1] || "")) {
      firstTopAwait = i;
    }
    for (const w of WANT) {
      if (marks[w] === undefined && text.startsWith(w, i)) { marks[w] = i; }
    }
  }
  return { firstTopAwait, marks, topRunScan };
}

const { firstTopAwait, marks, topRunScan } = scan(src, bodyStart);
const lineOf = i => src.slice(bodyStart, i).split("\n").length;

assert("registerWebviewViewProvider called in activate()", marks.registerWebviewViewProvider !== undefined);
assert("setOnReady wired in activate()", marks.setOnReady !== undefined);

// The initial scan IS awaited, deliberately — v1.9.14 and 1.10.95 both shipped
// a fire-and-forget scan and both rendered a dashboard full of zeros. What must
// hold is that the sidebar is wired before that await, so registration cannot
// be lost if activation later fails.
assert("activate() kicks off the cold-start scan", topRunScan.length > 0, `${topRunScan.length} top-level call(s)`);

// Everything sidebar-related must be wired before the first top-level await.
if (firstTopAwait !== -1) {
  for (const w of WANT) {
    if (marks[w] === undefined) { continue; }
    assert(
      `${w} runs BEFORE the first top-level await`,
      marks[w] < firstTopAwait,
      `${w}@line ${lineOf(marks[w])}, first await@line ${lineOf(firstTopAwait)}`
    );
  }
} else {
  console.log("  INFO  activate() has no top-level await");
}

if (marks.registerWebviewViewProvider !== undefined && topRunScan.length > 0) {
  assert("provider registered before the scan starts",
    marks.registerWebviewViewProvider < topRunScan[0],
    `register@line ${lineOf(marks.registerWebviewViewProvider)}, scan@line ${lineOf(topRunScan[0])}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
