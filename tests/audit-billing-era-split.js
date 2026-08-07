// Full audit: for pre-AIC (May), post-AIC historical (July), and current
// cycle (August), print the numbers each hero + AIC section should show.
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
const { buildDashboardData, AIC_EFFECTIVE_DATE } = require(path.join(OUT, 'dashboardData.js'));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, 'aicCredits.js'));

function fmtN(n) { return Number(n || 0).toLocaleString(); }
function bucket(sessions, start, end) {
  return sessions.filter(s => s.lastDate && s.lastDate >= start && s.lastDate <= end);
}

(async () => {
  const scan = await scanWorkspaceStorage();
  const data = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG);
  const aic = data.aicSummary;

  const cases = [
    { label: '2026-05 (pre-AIC)',       start: '2026-05-01', end: '2026-05-31', isPreAic: true  },
    { label: '2026-07 (post-AIC hist)', start: '2026-07-01', end: '2026-07-31', isPreAic: false },
    { label: '2026-08 (current cycle)', start: '2026-08-01', end: '2026-08-31', isPreAic: false },
  ];

  console.log('AIC_EFFECTIVE_DATE = ' + AIC_EFFECTIVE_DATE);
  console.log('Plan: ' + aic.planName + ' · included premium reqs: ' + aic.includedPremiumRequests + ' · credit budget: ' + aic.monthlyBudget);
  console.log('');

  for (const c of cases) {
    const arr = bucket(data.sessionsAll, c.start, c.end);
    const turns   = arr.reduce((s,x) => s + (x.turns||0), 0);
    const credits = arr.reduce((s,x) => s + (x.aicCredits||0), 0);
    const preReqs = arr.reduce((s,x) => s + (x.multiplier || 1) * (x.turns || 0), 0);
    const included = aic.includedPremiumRequests;
    const preOver = Math.max(0, preReqs - included);
    console.log('── ' + c.label + ' ──');
    console.log('  sessions:       ' + arr.length);
    console.log('  turns:          ' + fmtN(turns));
    console.log('  premium reqs:   ' + fmtN(Math.round(preReqs)) + ' (turns × multiplier)');
    console.log('  aic credits:    ' + credits.toFixed(2));
    if (c.isPreAic) {
      console.log('  → HERO shows:   Premium Requests = ' + fmtN(Math.round(preReqs)));
      console.log('  → AIC-SEC:      Premium Requests panel · reconstruction only');
      console.log('  → Overage req:  ' + fmtN(Math.round(preOver)) + ' × $0.04 = $' + (preOver * 0.04).toFixed(2));
    } else {
      const over = Math.max(0, credits - aic.monthlyBudget) * 0.01;
      console.log('  → HERO shows:   AI Credits Spent = ' + credits.toFixed(1));
      console.log('  → AIC-SEC:      Total Credits card · budget bar · overage $' + over.toFixed(2));
    }
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
