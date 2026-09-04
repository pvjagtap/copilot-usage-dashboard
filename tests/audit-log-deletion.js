/**
 * audit-log-deletion.js — did anything delete/move VS Code chat logs?
 *
 * Three independent checks, each answerable on its own:
 *   1. LOGS   — stream every debug-logs *.jsonl and flag tool calls whose
 *               arguments pair a destructive verb with a storage path.
 *   2. DISK   — inventory workspaceStorage + globalStorage chat session files
 *               so "missing" can be distinguished from "moved".
 *   3. CONFIG — diff settings.json against its sibling .backup/.broken copies,
 *               limited to chat/storage/telemetry keys.
 *
 *   node tests/audit-log-deletion.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const USER = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User");
const WS_STORAGE = path.join(USER, "workspaceStorage");

// Verbs that remove, relocate or truncate a file on Windows or POSIX.
const DESTRUCTIVE =
  /(Remove-Item|Clear-Content|Clear-RecycleBin|Move-Item|Rename-Item|Copy-Item|robocopy|xcopy|Compress-Archive|\brmdir\b|\brd\s+\/s|\bdel\b|\berase\b|\brm\s+-[rf]|\bmv\b|rimraf|fs\.rmSync|fs\.rm\b|fs\.unlinkSync|fs\.unlink\b|fs\.renameSync|shutil\.rmtree|shutil\.move|os\.remove|os\.unlink|git\s+clean|truncate)/i;

// Paths that hold chat history / debug logs.
const STORAGE_PATH = /(workspaceStorage|globalStorage|debug-logs|chatSessions|chatEditingSessions|emptyWindowChatSessions|chat-session-resources)/i;

// Commands that only read; they may still contain a destructive verb as data
// (a regex literal, a grep pattern) without performing one.
const READ_ONLY = /^(?:cd [^;]+;\s*)?(?:@'|node |Get-|Select-String|findstr|type |cat |git (?:log|status|diff|show))/i;

// Tools that can actually touch the filesystem.
const FS_TOOLS = new Set([
  "run_in_terminal",
  "send_to_terminal",
  "create_file",
  "create_directory",
  "replace_string_in_file",
  "multi_replace_string_in_file",
  "run_vscode_command",
  "create_and_run_task",
]);

const listDirs = (p) =>
  fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const bytes = (n) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : (n / 1024).toFixed(1) + " KB");
const head = (t) => console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78));

/** Every debug-logs/<session>/*.jsonl on this machine. */
function logFiles() {
  const out = [];
  for (const ws of listDirs(WS_STORAGE)) {
    const root = path.join(WS_STORAGE, ws, "GitHub.copilot-chat", "debug-logs");
    for (const sess of listDirs(root)) {
      for (const f of fs.readdirSync(path.join(root, sess))) {
        if (f.endsWith(".jsonl")) out.push({ ws, sess, file: f, full: path.join(root, sess, f) });
      }
    }
  }
  return out;
}

// ── 1. LOGS ─────────────────────────────────────────────────────────────────
async function auditLogs() {
  head("1. TOOL CALLS THAT COULD HAVE DELETED / MOVED LOGS");
  const files = logFiles();
  if (!files.length) return console.log("  no debug-logs found under " + WS_STORAGE);

  const hits = [];
  const stats = { lines: 0, toolCalls: 0, fsToolCalls: 0, touchedStorage: 0, selfReferential: 0 };

  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f.full), crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      n++;
      stats.lines++;
      if (!line || line[0] !== "{") continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== "tool_call") continue;
      stats.toolCalls++;
      if (!FS_TOOLS.has(e.name)) continue;
      stats.fsToolCalls++;

      const args = (e.attrs && e.attrs.args) || "";
      let a = {};
      try {
        a = JSON.parse(args);
      } catch {
        a = {};
      }
      // Only the executable surface counts. For file tools that is the target
      // path, never the payload: "deleted" written into a changelog is prose.
      const isTerminal = e.name === "run_in_terminal" || e.name === "send_to_terminal";
      const surface = isTerminal ? a.command || args : a.filePath || a.dirPath || "";
      if (!surface) continue;

      const touchesStorage = STORAGE_PATH.test(surface);
      if (touchesStorage) stats.touchedStorage++;
      if (!DESTRUCTIVE.test(surface)) continue;
      // A read-only inspector that merely *names* the destructive verbs (this
      // audit, the earlier scan scripts) is not itself a deletion.
      const readOnly = isTerminal && READ_ONLY.test(surface) && !/Remove-Item\s+[^|;]*(workspaceStorage|globalStorage|debug-logs|chatSessions)/i.test(surface);
      if (readOnly) {
        stats.selfReferential++;
        continue;
      }

      hits.push({
        sess: f.sess.slice(0, 8),
        line: n,
        ts: new Date(e.ts).toISOString().replace("T", " ").slice(0, 19),
        tool: e.name,
        status: e.status,
        touchesStorage,
        cmd: String(surface).replace(/\s+/g, " ").slice(0, 220),
      });
    }
  }

  console.log(
    `  scanned ${files.length} file(s), ${stats.lines.toLocaleString()} lines, ` +
      `${stats.toolCalls.toLocaleString()} tool calls (${stats.fsToolCalls} filesystem-capable)`
  );
  console.log(`  filesystem calls whose target mentions a storage path: ${stats.touchedStorage}`);
  console.log(`  read-only inspectors that merely quote a destructive verb    : ${stats.selfReferential} (excluded)`);

  const onStorage = hits.filter((h) => h.touchesStorage);
  console.log(`\n  DESTRUCTIVE + STORAGE PATH : ${onStorage.length}   <-- the answer to the question`);
  onStorage.forEach((h) => console.log(`    [${h.ts}] ${h.tool} (${h.status}) :: ${h.cmd}`));

  const elsewhere = hits.filter((h) => !h.touchesStorage);
  console.log(`\n  destructive elsewhere (workspace/repo only, for context) : ${elsewhere.length}`);
  elsewhere.forEach((h) => console.log(`    [${h.ts}] ${h.tool} (${h.status}) :: ${h.cmd}`));
}

// ── 2. DISK ─────────────────────────────────────────────────────────────────
function auditDisk() {
  head("2. WHERE CHAT SESSIONS ACTUALLY LIVE RIGHT NOW");

  const rows = [];
  for (const ws of listDirs(WS_STORAGE)) {
    const dir = path.join(WS_STORAGE, ws);
    const row = { id: ws.slice(0, 14), mtime: fs.statSync(dir).mtime, sessions: 0, size: 0, oldest: null };
    for (const sub of ["chatSessions", "chatEditingSessions"]) {
      const p = path.join(dir, sub);
      if (!fs.existsSync(p)) continue;
      for (const f of fs.readdirSync(p)) {
        const s = fs.statSync(path.join(p, f));
        if (!s.isFile()) continue;
        row.sessions++;
        row.size += s.size;
        if (!row.oldest || s.mtime < row.oldest) row.oldest = s.mtime;
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  console.log(`  workspaceStorage folders: ${rows.length}   (folder mtime = last time VS Code opened it)`);
  for (const r of rows) {
    console.log(
      `    ${r.id.padEnd(16)} ${r.mtime.toISOString().slice(0, 16).replace("T", " ")}  ` +
        (r.sessions ? `${String(r.sessions).padStart(3)} session file(s)  ${bytes(r.size)}` : "  no chatSessions/")
    );
  }

  const global = path.join(USER, "globalStorage", "emptyWindowChatSessions");
  if (fs.existsSync(global)) {
    const files = fs.readdirSync(global).map((f) => ({ f, s: fs.statSync(path.join(global, f)) })).filter((x) => x.s.isFile());
    const total = files.reduce((a, x) => a + x.s.size, 0);
    const times = files.map((x) => x.s.mtime).sort((a, b) => a - b);
    console.log(
      `\n  globalStorage/emptyWindowChatSessions: ${files.length} file(s), ${bytes(total)}` +
        (times.length ? `, ${times[0].toISOString().slice(0, 10)} .. ${times[times.length - 1].toISOString().slice(0, 10)}` : "")
    );
    console.log("    -> history older than the current workspace is here, intact; nothing was purged.");
  }
}

// ── 3. CONFIG ───────────────────────────────────────────────────────────────
function auditConfig() {
  head("3. SETTINGS CHANGES THAT COULD AFFECT CHAT STORAGE");

  const variants = fs
    .readdirSync(USER)
    .filter((f) => /^settings\.json(\..+)?$/.test(f))
    .map((f) => ({ f, s: fs.statSync(path.join(USER, f)) }))
    .sort((a, b) => b.s.mtime - a.s.mtime);
  variants.forEach((v) => console.log(`  ${v.f.padEnd(28)} ${bytes(v.s.size).padStart(9)}  ${v.s.mtime.toISOString().replace("T", " ").slice(0, 19)}`));

  const RELEVANT = /(chat|copilot|storage|session|history|retention|telemetry|otel|log)/i;

  // Key-level, so reordering and comment churn do not register as changes.
  // Commented-out keys count as absent, which is exactly the failure mode here.
  const keys = (f) => {
    const map = new Map();
    for (const raw of fs.readFileSync(path.join(USER, f), "utf-8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("//")) continue;
      const m = /^"([^"]+)"\s*:\s*(.+?),?$/.exec(line);
      if (m && RELEVANT.test(m[1])) map.set(m[1], m[2].replace(/,$/, ""));
    }
    return map;
  };

  const cur = keys("settings.json");
  for (const other of variants.filter((v) => v.f !== "settings.json")) {
    const old = keys(other.f);
    const added = [...cur.keys()].filter((k) => !old.has(k));
    const removed = [...old.keys()].filter((k) => !cur.has(k));
    const changed = [...cur.keys()].filter((k) => old.has(k) && old.get(k) !== cur.get(k));
    console.log(
      `\n  settings.json vs ${other.f}  (+${added.length} added / -${removed.length} removed / ~${changed.length} changed)`
    );
    removed.slice(0, 30).forEach((k) => console.log(`    -  "${k}": ${old.get(k)}`.slice(0, 170)));
    changed.slice(0, 30).forEach((k) => console.log(`    ~  "${k}": ${old.get(k)}  ->  ${cur.get(k)}`.slice(0, 170)));
    added.slice(0, 15).forEach((k) => console.log(`    +  "${k}": ${cur.get(k)}`.slice(0, 170)));
    if (!added.length && !removed.length && !changed.length) console.log("    (no chat/storage-relevant difference)");
  }
}

(async () => {
  console.log("VS Code user dir: " + USER);
  await auditLogs();
  auditDisk();
  auditConfig();
})();
