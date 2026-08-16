/**
 * verify-agent-root-sessions.js — agent session files written directly into
 * the sessions root (no project subfolder) must be scanned.
 *
 * Regression: scanDirectory() enumerated the sessions root and skipped every
 * entry that wasn't a directory, so loose <root>/*.jsonl sessions were dropped
 * silently. On a real profile that hid 57 llm calls / 908.50 credits of
 * github-copilot Pi usage, making the dashboard's Pi column under-report.
 *
 *   node tests/verify-agent-root-sessions.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

// A session whose only assistant message costs $usd, timestamped inside the
// current billing month so scanAgentSessions keeps it.
function sessionJsonl(id, usd, model, provider) {
  const now = new Date();
  const ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0) + 3600_000;
  return [
    JSON.stringify({ type: "session", id, cwd: "/tmp/x", title: id }),
    JSON.stringify({
      type: "message",
      timestamp: new Date(ts).toISOString(),
      message: {
        role: "assistant",
        model,
        provider,
        timestamp: ts,
        usage: {
          input: 10, output: 20, cacheRead: 30, cacheWrite: 40,
          cost: { input: 0, output: usd, cacheRead: 0, cacheWrite: 0, total: usd },
        },
      },
    }),
  ].join("\n");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scan-"));
  const sessions = path.join(tmp, "sessions");
  fs.mkdirSync(path.join(sessions, "some-project"), { recursive: true });

  fs.writeFileSync(path.join(sessions, "some-project", "nested.jsonl"),
    sessionJsonl("nested-1", 0.25, "claude-opus-5", "github-copilot"));
  fs.writeFileSync(path.join(sessions, "loose.jsonl"),
    sessionJsonl("loose-1", 0.75, "claude-opus-5", "github-copilot"));
  // Non-session noise at the root must not break or inflate the scan.
  fs.writeFileSync(path.join(sessions, "notes.txt"), "ignore me");
  fs.writeFileSync(path.join(sessions, "broken.jsonl"), "{not json\n");

  process.env["PI_CODING_AGENT_DIR"] = tmp;
  const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
  const scan = await scanAgentSessions();
  const pi = scan.sessions.filter(s => s.source === "pi");
  const ids = pi.map(s => s.sessionId).sort();
  const credits = pi.reduce((a, s) => a + s.totalCostCredits, 0);

  console.log(`fixture: ${sessions}`);
  assert("nested session scanned", ids.includes("nested-1"), ids.join(","));
  assert("loose root session scanned", ids.includes("loose-1"), ids.join(","));
  assert("exactly 2 sessions (no double-count)", pi.length === 2, pi.length);
  assert("credits = (0.25 + 0.75) * 100", Math.abs(credits - 100) < 0.01, credits.toFixed(2));
  assert("llmCalls totals 2", pi.reduce((a, s) => a + s.llmCalls, 0) === 2);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
