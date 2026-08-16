/**
 * verify-sidebar-html.js — the sidebar webview's inline script must parse.
 *
 * verify-webview-html.js only covers dashboardPanel.js. A syntax error in the
 * sidebar script produces a completely blank Activity Bar view with no error
 * surfaced anywhere in the UI, so it needs its own guard.
 *
 *   node tests/verify-sidebar-html.js
 */

const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { SidebarViewProvider } = require(path.join(OUT, "sidebarView.js"));

let failures = 0;
const provider = new SidebarViewProvider({ fsPath: __dirname, scheme: "file" });
const html = provider.getHtml();

console.log("sidebar HTML length:", html.length, "chars");

if (!/<body[\s>]/.test(html)) { console.log("  FAIL  no <body>"); failures++; }
if (!/id="root"/.test(html)) { console.log("  FAIL  no #root container"); failures++; }

const cspMatch = html.match(/Content-Security-Policy" content="([^"]+)"/);
const nonceMatch = html.match(/<script nonce="([^"]+)"/);
if (!cspMatch) { console.log("  FAIL  no CSP meta"); failures++; }
if (!nonceMatch) { console.log("  FAIL  script has no nonce"); failures++; }
if (cspMatch && nonceMatch) {
  const ok = cspMatch[1].includes(`'nonce-${nonceMatch[1]}'`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  script nonce matches CSP`);
  if (!ok) failures++;
}

const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, count = 0;
while ((m = scriptRe.exec(html)) !== null) {
  count++;
  try {
    // eslint-disable-next-line no-new-func
    new Function(m[1]);
    console.log(`  PASS  inline script #${count} parses (${m[1].length} chars)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  inline script #${count} — ${e.message}`);
    const pos = e.message.match(/\((\d+):(\d+)\)/);
    if (pos) {
      const lines = m[1].split("\n");
      const ln = Number(pos[1]);
      for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
        console.log(`      ${String(i + 1).padStart(5)}${i + 1 === ln ? " >" : "  "} ${lines[i]}`);
      }
    }
  }
}
if (count === 0) { console.log("  FAIL  no inline script found"); failures++; }

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
