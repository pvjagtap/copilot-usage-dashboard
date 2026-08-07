// Quick check: confirm historical SessionView rows carry actualPrompt/actualOutput
// and that the proportional-split fallback produces sensible per-model rows.
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const Module = require('module');
const stubPath = path.join(__dirname, '_vscode-stub.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage } = require(path.join(OUT, 'scanner.js'));
const { buildDashboardData } = require(path.join(OUT, 'dashboardData.js'));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, 'aicCredits.js'));

(async () => {
  const scan = await scanWorkspaceStorage();
  const data = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG);
  const july = data.sessionsAll.filter(s => s.lastDate && s.lastDate >= '2026-07-01' && s.lastDate <= '2026-07-31');
  const may  = data.sessionsAll.filter(s => s.lastDate && s.lastDate >= '2026-05-01' && s.lastDate <= '2026-05-31');
  for (const [label, arr] of [['2026-07', july], ['2026-05', may]]) {
    const perModel = {};
    arr.forEach(s => {
      const m = s.model || s.modelName || 'unknown';
      const r = perModel[m] || (perModel[m] = { total:0, tIn:0, tOut:0, tCa:0, n:0 });
      r.total += s.aicCredits || 0;
      r.tIn   += s.actualPrompt || s.prompt || 0;
      r.tOut  += s.actualOutput || s.output || 0;
      r.tCa   += s.actualCached || 0;
      r.n++;
    });
    console.log('\n' + label + ' (' + arr.length + ' sessions)');
    console.log('  ' + 'model'.padEnd(28) + 'sess'.padStart(6) + 'credits'.padStart(12) + 'tokIn'.padStart(14) + 'tokOut'.padStart(12) + 'tokCache'.padStart(12));
    Object.entries(perModel)
      .sort((a,b) => b[1].total - a[1].total)
      .slice(0, 6)
      .forEach(([m, r]) => {
        console.log(
          '  ' + m.padEnd(28) +
          String(r.n).padStart(6) +
          r.total.toFixed(2).padStart(12) +
          r.tIn.toLocaleString().padStart(14) +
          r.tOut.toLocaleString().padStart(12) +
          r.tCa.toLocaleString().padStart(12)
        );
      });
  }
})().catch(e => { console.error(e); process.exit(1); });
