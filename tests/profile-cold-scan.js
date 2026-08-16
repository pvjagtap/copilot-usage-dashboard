/**
 * profile-cold-scan.js — where do the 90 seconds go?
 *
 * The scanner's mtime caches (_sessionBundleCache / _debugLogCache) are
 * module-level Maps, so every extension-host restart pays a full cold scan.
 * This measures the raw I/O and parse cost so we know whether a persistent
 * cache would actually help.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const WS = path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage");
const fmtB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB";

async function main() {
  console.log("workspaceStorage:", WS, "\n");

  // Inventory: chatSessions JSON + debug-log main.jsonl (+ children)
  const chatFiles = [];
  const debugFiles = [];
  const wsHashes = await fsp.readdir(WS).catch(() => []);
  for (const h of wsHashes) {
    const cs = path.join(WS, h, "chatSessions");
    for (const f of await fsp.readdir(cs).catch(() => [])) {
      if (f.endsWith(".json")) chatFiles.push(path.join(cs, f));
    }
    const dl = path.join(WS, h, "GitHub.copilot-chat", "debug-logs");
    const stack = [dl];
    while (stack.length) {
      const d = stack.pop();
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith(".jsonl")) debugFiles.push(p);
      }
    }
  }

  const sizeOf = async list => {
    let total = 0;
    for (const f of list) { try { total += (await fsp.stat(f)).size; } catch { /* gone */ } }
    return total;
  };

  let t = Date.now();
  const chatBytes = await sizeOf(chatFiles);
  const debugBytes = await sizeOf(debugFiles);
  const statMs = Date.now() - t;

  console.log(`workspaces          : ${wsHashes.length}`);
  console.log(`chatSessions files  : ${chatFiles.length.toLocaleString().padStart(7)}  ${fmtB(chatBytes)}`);
  console.log(`debug-log jsonl     : ${debugFiles.length.toLocaleString().padStart(7)}  ${fmtB(debugBytes)}`);
  console.log(`total               : ${(chatFiles.length + debugFiles.length).toLocaleString().padStart(7)}  ${fmtB(chatBytes + debugBytes)}`);
  console.log(`stat() all files    : ${statMs} ms\n`);

  // Raw read cost (concurrency 32, same as the scanner)
  const readAll = async (list, label) => {
    const t0 = Date.now();
    let bytes = 0;
    const q = list.slice();
    const workers = Array.from({ length: 32 }, async () => {
      for (;;) {
        const f = q.pop();
        if (!f) return;
        try { bytes += (await fsp.readFile(f, "utf-8")).length; } catch { /* gone */ }
      }
    });
    await Promise.all(workers);
    console.log(`read ${label.padEnd(18)}: ${String(Date.now() - t0).padStart(6)} ms  (${fmtB(bytes)})`);
    return Date.now() - t0;
  };
  const rc = await readAll(chatFiles, "chatSessions");
  const rd = await readAll(debugFiles, "debug logs");

  // JSON.parse cost for chatSessions (the scanner parses every one)
  let t2 = Date.now();
  let parsed = 0;
  for (const f of chatFiles) {
    try { JSON.parse(await fsp.readFile(f, "utf-8")); parsed++; } catch { /* skip */ }
  }
  console.log(`JSON.parse chat     : ${String(Date.now() - t2).padStart(6)} ms  (${parsed} files)`);

  // Line-split + parse cost for debug logs
  t2 = Date.now();
  let lines = 0;
  for (const f of debugFiles) {
    try {
      const txt = await fsp.readFile(f, "utf-8");
      for (const l of txt.split("\n")) { if (l.trim()) { JSON.parse(l); lines++; } }
    } catch { /* skip */ }
  }
  console.log(`parse debug lines   : ${String(Date.now() - t2).padStart(6)} ms  (${lines.toLocaleString()} events)`);

  // Real scanner, cold (fresh module instance = empty caches)
  const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
  t2 = Date.now();
  const scan = await scanWorkspaceStorage(WS);
  const cold = Date.now() - t2;
  t2 = Date.now();
  await scanWorkspaceStorage(WS);
  const warm = Date.now() - t2;
  console.log(`\nscanner COLD        : ${cold.toLocaleString()} ms   (${scan.stats.canonicalSessions} sessions, ${scan.stats.turnsStored} turns)`);
  console.log(`scanner WARM        : ${warm.toLocaleString()} ms`);
  console.log(`\n=> cold-start cost that a persistent cache would remove: ~${(cold - warm).toLocaleString()} ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
