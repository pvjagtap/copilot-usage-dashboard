/**
 * verify-fixture-corpus.js — scan the committed workspaceStorage corpus and
 * reconcile parsed sessions against the files actually on disk.
 *
 *   node tests/verify-fixture-corpus.js [corpusDir]
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) {
  return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a);
};

const corpus = path.resolve(process.argv[2] || path.join(__dirname, "2026-08-07_12-12"));
const { scanWorkspaceStorage } = require(path.join(__dirname, "..", "out", "scanner.js"));

// ── Ground truth straight off disk ──────────────────────────────────────────
const truth = { dirs: 0, withChat: 0, files: 0, jsonl: 0, json: 0, bytes: 0 };
const diskFiles = new Set();
for (const w of fs.readdirSync(corpus)) {
  const wsDir = path.join(corpus, w);
  if (!fs.statSync(wsDir).isDirectory()) continue;
  truth.dirs++;
  const cs = path.join(wsDir, "chatSessions");
  if (!fs.existsSync(cs)) continue;
  truth.withChat++;
  for (const f of fs.readdirSync(cs)) {
    if (!f.endsWith(".jsonl") && !f.endsWith(".json")) continue;
    truth.files++;
    if (f.endsWith(".jsonl")) truth.jsonl++;
    else truth.json++;
    truth.bytes += fs.statSync(path.join(cs, f)).size;
    diskFiles.add(path.join(cs, f));
  }
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

(async () => {
  console.log("corpus:", corpus);
  console.log(
    `on disk: ${truth.dirs} dirs, ${truth.withChat} with chatSessions, ` +
      `${truth.files} files (${truth.jsonl} jsonl / ${truth.json} json), ` +
      `${(truth.bytes / 1048576).toFixed(1)} MB\n`
  );

  const t0 = Date.now();
  const scan = await scanWorkspaceStorage(corpus);
  const ms = Date.now() - t0;

  const parsedFiles = new Set();
  for (const s of scan.sessions) for (const p of s.sourcePaths || [s.sourcePath]) parsedFiles.add(p);

  const projects = new Set(scan.sessions.map(s => s.projectName));
  const credits = scan.turns.reduce((a, t) => a + (t.debugAicCredits || 0), 0);
  const prompt = scan.sessions.reduce((a, s) => a + (s.totalPromptTokens || 0), 0);
  const output = scan.sessions.reduce((a, s) => a + (s.totalOutputTokens || 0), 0);

  console.log(
    `scanned in ${ms}ms: ${scan.sessions.length} sessions, ${scan.turns.length} turns, ` +
      `${scan.toolCalls.length} toolCalls, ${projects.size} projects`
  );
  console.log(`tokens: prompt=${prompt.toLocaleString()} output=${output.toLocaleString()} credits=${credits.toFixed(2)}\n`);

  const missed = [...diskFiles].filter(f => !parsedFiles.has(f));
  const extra = [...parsedFiles].filter(f => !diskFiles.has(f));

  check("every chatSessions file was read", missed.length === 0, `${parsedFiles.size}/${truth.files}`);
  check("no files pulled in from outside the corpus", extra.length === 0, extra.length + " foreign");
  check("sessions produced", scan.sessions.length > 0, scan.sessions.length);
  check("turns produced", scan.turns.length > 0, scan.turns.length);
  check("no session leaked the (no folder) global store", !projects.has("(no folder)"));

  // Legacy single-object `.json` sessions were skipped entirely before 1.10.98.
  const fromJson = scan.sessions.filter(s =>
    (s.sourcePaths || [s.sourcePath]).some(p => p.endsWith(".json"))
  );
  check("legacy .json sessions parsed", truth.json === 0 || fromJson.length > 0, `${fromJson.length} of ${truth.json} files`);

  if (missed.length) {
    console.log(`\n  files on disk the scanner did not read (${missed.length}):`);
    for (const f of missed.slice(0, 15)) {
      const kb = (fs.statSync(f).size / 1024).toFixed(0);
      console.log(`    ${path.basename(path.dirname(path.dirname(f))).slice(0, 12)}  ${(kb + "KB").padStart(8)}  ${path.basename(f)}`);
    }
    if (missed.length > 15) console.log(`    … ${missed.length - 15} more`);
  }
  if (extra.length) {
    console.log(`\n  UNEXPECTED files read from outside the corpus (${extra.length}):`);
    for (const f of extra.slice(0, 10)) console.log("    " + f);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
