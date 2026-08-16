/**
 * verify-workspace-hash.js — `storageUri` is
 * `<...>/workspaceStorage/<hash>/<extensionId>`, so the hash is the segment
 * AFTER `workspaceStorage`, not the last one. Taking the last segment yielded
 * the extension id, so no project ever matched and every row rendered as the
 * `workspace-<hash8>` fallback.
 *
 *   node tests/verify-workspace-hash.js
 */

const path = require("path");
const Module = require("module");

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) {
  return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a);
};

const { workspaceHashFromStorageUri } = require(path.join(__dirname, "..", "out", "extension.js"));

const HASH = "3e4338661f1dbcde6b5023cc270b330b";
const cases = [
  ["windows storageUri", `C:\\Users\\J\\AppData\\Roaming\\Code\\User\\workspaceStorage\\${HASH}\\pvjagtap.copilot-usage-dashboard`, HASH],
  ["linux storageUri", `/home/j/.config/Code/User/workspaceStorage/${HASH}/pvjagtap.copilot-usage-dashboard`, HASH],
  ["remote storageUri", `/home/j/.vscode-server/data/User/workspaceStorage/${HASH}/pvjagtap.copilot-usage-dashboard`, HASH],
  ["trailing separator", `C:\\Code\\User\\workspaceStorage\\${HASH}\\pvjagtap.ext\\`, HASH],
  ["hash dir with no ext segment", `C:\\Code\\User\\workspaceStorage\\${HASH}`, HASH],
  ["unknown layout, ext id last", `D:\\weird\\${HASH}\\pvjagtap.copilot-usage-dashboard`, HASH],
  ["undefined (no folder open)", undefined, ""],
  ["empty string", "", ""],
];

let failures = 0;
for (const [label, input, expected] of cases) {
  const got = workspaceHashFromStorageUri(input);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  ->  ${JSON.stringify(got)}${ok ? "" : `  expected ${JSON.stringify(expected)}`}`);
}

// The regression itself: the old implementation was path.basename(storagePath).
const legacy = path.basename(`C:\\Code\\User\\workspaceStorage\\${HASH}\\pvjagtap.copilot-usage-dashboard`);
const ok = legacy !== HASH;
console.log(`  ${ok ? "PASS" : "FAIL"}  old basename() approach returns the extension id, not the hash  (${legacy})`);
if (!ok) failures++;

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
