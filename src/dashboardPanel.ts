/**
 * dashboardPanel.ts — Full dashboard webview for VS Code.
 * Ports the entire dashboard.py HTML template to TypeScript.
 * Includes: stats grid, live OTel, daily chart, model pie,
 * top tools, top projects, sessions table, model usage, subagent table.
 */

import * as vscode from "vscode";
import { DashboardData } from "./dashboardData";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  static onRefreshRateChange: ((intervalMs: number) => void) | undefined;
  static onManualRefresh: (() => void) | undefined;
  static onOpenFile: ((filePath: string) => void) | undefined;
  private panel: vscode.WebviewPanel;
  private disposed = false;

  static show(extensionUri: vscode.Uri, data: DashboardData): DashboardPanel {
    if (DashboardPanel.instance && !DashboardPanel.instance.disposed) {
      DashboardPanel.instance.panel.reveal();
      DashboardPanel.instance.update(data);
      return DashboardPanel.instance;
    }
    const inst = new DashboardPanel(extensionUri, data);
    DashboardPanel.instance = inst;
    return inst;
  }

  /** Update dashboard data only if the panel is already open — never creates or steals focus */
  static updateIfVisible(data: DashboardData): void {
    if (DashboardPanel.instance && !DashboardPanel.instance.disposed) {
      DashboardPanel.instance.update(data);
    }
  }

  private constructor(extensionUri: vscode.Uri, data: DashboardData) {
    this.panel = vscode.window.createWebviewPanel(
      "copilotUsageDashboard",
      "Copilot Usage Dashboard",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      DashboardPanel.instance = undefined;
    });
    this.panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === "refreshRate" && DashboardPanel.onRefreshRateChange) {
        DashboardPanel.onRefreshRateChange(msg.intervalMs);
      } else if (msg.type === "manualRefresh" && DashboardPanel.onManualRefresh) {
        DashboardPanel.onManualRefresh();
      } else if (msg.type === "openFile" && msg.path && DashboardPanel.onOpenFile) {
        DashboardPanel.onOpenFile(msg.path);
      }
    });
    this.panel.webview.html = this.buildHtml(data);
  }

  update(data: DashboardData): void {
    if (this.disposed) {
      return;
    }
    this.panel.webview.postMessage({ type: "updateData", data });
  }

  private buildHtml(data: DashboardData): string {
    const jsonData = JSON.stringify(data);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:;">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
:root {
  --bg: #0d1117; --card: #161b22; --border: #30363d;
  --fg: #e6edf3; --muted: #a8b1bb; --blue: #58a6ff;
  --green: #3fb950; --orange: #d29922; --red: #f85149;
  --purple: #bc8cff;
  --grid: #30363d33;
  --chart-bar1: rgba(88,166,255,0.82); --chart-bar2: rgba(188,140,255,0.82);
  --peak-bar: rgba(248,81,73,0.75); --normal-bar: rgba(210,153,34,0.75);
  --pill-blue-bg: #0d1d33; --pill-blue-border: #1f3a5f;
  --pill-green-bg: #0d2818; --pill-green-border: #1a4731;
  --pill-orange-bg: #2d1f0d; --pill-orange-border: #4a3319;
  --model-opus-bg: #1a1a2e; --model-opus-fg: #c084fc; --model-opus-border: #7c3aed44;
  --model-sonnet-bg: #1a2332; --model-sonnet-fg: #93c5fd; --model-sonnet-border: #3b82f644;
  --model-haiku-bg: #1a2e2e; --model-haiku-fg: #5eead4; --model-haiku-border: #14b8a644;
  --model-gpt-bg: #1a2e1a; --model-gpt-fg: #86efac; --model-gpt-border: #22c55e44;
  --model-gemini-bg: #2e2e1a; --model-gemini-fg: #fde68a; --model-gemini-border: #f59e0b44;
  --mult-high-bg: #2d1f0d; --mult-high-border: #4a331944;
  --link-bg: rgba(88,166,255,0.08); --link-border: rgba(88,166,255,0.35); --link-hover-bg: rgba(88,166,255,0.14);
}
body.vscode-light {
  --bg: #f5f0e8; --card: #ffffff; --border: #e0d8cc;
  --fg: #2d2a26; --muted: #5a544f; --blue: #2563eb;
  --green: #16a34a; --orange: #b45309; --red: #dc2626;
  --purple: #7c3aed;
  --grid: #d8d0c433;
  --chart-bar1: rgba(37,99,235,0.72); --chart-bar2: rgba(124,58,237,0.72);
  --peak-bar: rgba(220,38,38,0.65); --normal-bar: rgba(180,83,9,0.65);
  --pill-blue-bg: #eff6ff; --pill-blue-border: #bfdbfe;
  --pill-green-bg: #f0fdf4; --pill-green-border: #bbf7d0;
  --pill-orange-bg: #fffbeb; --pill-orange-border: #fde68a;
  --model-opus-bg: #faf5ff; --model-opus-fg: #7c3aed; --model-opus-border: #c4b5fd;
  --model-sonnet-bg: #eff6ff; --model-sonnet-fg: #2563eb; --model-sonnet-border: #93c5fd;
  --model-haiku-bg: #f0fdfa; --model-haiku-fg: #0f766e; --model-haiku-border: #99f6e4;
  --model-gpt-bg: #f0fdf4; --model-gpt-fg: #16a34a; --model-gpt-border: #86efac;
  --model-gemini-bg: #fefce8; --model-gemini-fg: #a16207; --model-gemini-border: #fde68a;
  --mult-high-bg: #fffbeb; --mult-high-border: #fde68a;
  --link-bg: rgba(37,99,235,0.06); --link-border: rgba(37,99,235,0.3); --link-hover-bg: rgba(37,99,235,0.12);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; padding: 10px 16px 20px; font-feature-settings: 'tnum' 1, 'ss01' 1; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
.topbar-left { min-width: 0; display: flex; flex-direction: column; }
.topbar-left h1 { margin: 0; }
h1 { font-size: 18px; margin-bottom: 0; display: flex; align-items: center; gap: 8px; line-height: 1.2; font-weight: 700; }
h1 svg { width: 22px; height: 22px; }
.subtitle { color: var(--muted); font-size: 12px; margin-bottom: 0; margin-top: 3px; font-weight: 500; }
.filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 0; flex-wrap: wrap; }
.filter-bar label { font-size: 12px; color: var(--fg); cursor: pointer; }
.filter-group { display: inline-flex; align-items: center; gap: 6px; }
.filter-label { font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; }
.filter-select { font-size: 13px; padding: 5px 26px 5px 10px; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; min-width: 130px; font-weight: 500; -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.filter-select:hover { border-color: var(--blue); }
.filter-select:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 2px rgba(88,166,255,0.25); }
.filter-select option { background: var(--card); color: var(--fg); }
.btn-sm { font-size: 11px; padding: 3px 10px; background: var(--card); color: var(--blue); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.btn-sm:hover { background: var(--border); }
.model-dd { position: relative; display: inline-block; }
.model-dd-btn { font-size: 12px; padding: 5px 26px 5px 10px; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; min-width: 180px; text-align: left; position: relative; font-family: inherit; }
.model-dd-btn:hover { border-color: var(--blue); }
.model-dd-btn::after { content: ''; position: absolute; right: 10px; top: 50%; margin-top: -2px; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--muted); }
.model-dd-panel { position: absolute; top: calc(100% + 4px); left: 0; min-width: 240px; max-height: 340px; overflow-y: auto; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px; z-index: 100; box-shadow: 0 6px 18px rgba(0,0,0,0.45); display: none; }
.model-dd.open .model-dd-panel { display: block; }
.model-dd.open .model-dd-btn { border-color: var(--blue); }
.model-dd-actions { display: flex; gap: 6px; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--border); }
.model-dd-actions .btn-sm { flex: 1; text-align: center; }
.model-dd-list { display: flex; flex-direction: column; gap: 2px; }
.model-dd-list label { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
.model-dd-list label:hover { background: var(--border); }
.model-dd-list input[type="checkbox"] { margin: 0; cursor: pointer; }
.btn-refresh { font-size: 13px; padding: 4px 9px; background: var(--card); color: var(--green); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; line-height: 1; }
.btn-refresh:hover { background: var(--border); border-color: var(--green); }
.btn-refresh.spinning { animation: spin 0.8s linear; pointer-events: none; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.stats-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; min-width: 200px; flex: 1;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 40%); column-gap: 12px; align-items: center; }
.stat-card .label { grid-column: 1; grid-row: 1; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; font-weight: 700; white-space: normal; word-break: break-word; text-align: left; }
.stat-card .value { grid-column: 2; grid-row: 1 / -1; align-self: center; justify-self: stretch; text-align: center; font-size: 24px; font-weight: 700; line-height: 1.1; letter-spacing: -0.3px; white-space: nowrap; }
.stat-card .sub   { grid-column: 1; grid-row: 2; font-size: 11px; color: var(--muted); font-weight: 500; white-space: normal; word-break: break-word; text-align: left; margin-top: 2px; }
.cached { color: var(--green) !important; }
.orange { color: var(--orange) !important; }
.table-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg); margin-bottom: 8px; }
.section-subtitle { font-size: 13px; color: var(--green); font-weight: 500; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 700; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
.table-scroll { overflow-x: auto; overflow-y: hidden; }
.table-scroll table { min-width: 100%; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.source-usage table th { font-size: 12px; padding: 8px 10px; }
.source-usage table td { font-size: 13px; padding: 10px; }
.source-usage .section-title { font-size: 15px; }
.source-usage .section-subtitle { font-size: 12px; }
.model-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 500; display: inline-block; }
.model-opus { background: var(--model-opus-bg); color: var(--model-opus-fg); border: 1px solid var(--model-opus-border); }
.model-sonnet { background: var(--model-sonnet-bg); color: var(--model-sonnet-fg); border: 1px solid var(--model-sonnet-border); }
.model-haiku { background: var(--model-haiku-bg); color: var(--model-haiku-fg); border: 1px solid var(--model-haiku-border); }
.model-gpt { background: var(--model-gpt-bg); color: var(--model-gpt-fg); border: 1px solid var(--model-gpt-border); }
.model-gemini { background: var(--model-gemini-bg); color: var(--model-gemini-fg); border: 1px solid var(--model-gemini-border); }
.model-default { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
.charts-grid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 16px; }
@media (min-width: 900px) { .charts-grid { grid-template-columns: 1fr 1fr; } }
.chart-wide { grid-column: 1 / -1; }
.chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; min-width: 0; overflow: hidden; }
.chart-card h3 { font-size: 14px; text-transform: uppercase; color: var(--fg); margin-bottom: 10px; font-weight: 700; letter-spacing: 0.4px; }
.chart-card canvas { display: block; max-width: 100%; }
.chart-frame { position: relative; width: 100%; height: 340px; }
.chart-frame-pie { height: 380px; }
.chart-frame-wide { height: 320px; }
.chart-scroll { overflow-x: hidden; overflow-y: auto; max-height: 500px; min-height: 300px; }
.chart-tall { position: relative; width: 100%; min-height: 300px; }
.chart-frame > canvas,
.chart-tall > canvas { width: 100% !important; height: 100% !important; }
@media (max-width: 700px) {
  .chart-frame { height: 280px; }
  .chart-frame-pie { height: 320px; }
  .chart-frame-wide { height: 260px; }
}
.tz-toggle { display: inline-flex; gap: 0; margin-left: auto; }
.tz-btn { font-size: 11px; padding: 3px 10px; background: var(--card); color: var(--muted); border: 1px solid var(--border); cursor: pointer; }
.tz-btn:first-child { border-radius: 4px 0 0 4px; }
.tz-btn:last-child { border-radius: 0 4px 4px 0; }
.tz-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
.empty-panel { color: var(--muted); font-size: 13px; padding: 20px; text-align: center; font-weight: 500; }
.note { color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 8px; font-weight: 500; }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--card); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; display: inline-block; margin: 1px; }
.pill-blue { background: var(--pill-blue-bg); color: var(--blue); border-color: var(--pill-blue-border); }
.pill-green { background: var(--pill-green-bg); color: var(--green); border-color: var(--pill-green-border); }
.pill-orange { background: var(--pill-orange-bg); color: var(--orange); border-color: var(--pill-orange-border); }
.file-link { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 10px; text-decoration: none; border: 1px solid var(--link-border); color: var(--blue); background: var(--link-bg); cursor: pointer; }
.file-link:hover { border-color: var(--blue); background: var(--link-hover-bg); }
.file-links { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.mult-badge { font-size: 9px; padding: 0 4px; border-radius: 3px; margin-left: 4px; }
.mult-1 { background: transparent; color: var(--blue); }
.mult-low { background: transparent; color: var(--green); }
.mult-high { background: var(--mult-high-bg); color: var(--orange); border: 1px solid var(--mult-high-border); }
.summary-cell { max-width: 260px; }
.summary-cell .title { font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary-cell .preview { color: var(--muted); font-size: 11px; margin-top: 1px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary-cell .tags { margin-top: 2px; }
.sessions-scroll { max-height: 600px; overflow-y: auto; }
.sessions-scroll::-webkit-scrollbar { width: 6px; }
.sessions-scroll::-webkit-scrollbar-track { background: var(--bg); }
.sessions-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.sessions-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* ===== Redesign: hero cards, tabs, expanders, captions ===== */
.hero-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; margin-bottom: 10px; }
.hero-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px 10px 16px; position: relative; overflow: hidden;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(140px, 42%); column-gap: 14px; align-items: center; }
.hero-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--blue); border-radius: 10px 0 0 10px; }
.hero-card.accent-orange::before { background: var(--orange); }
.hero-card.accent-green::before { background: var(--green); }
.hero-card.accent-purple::before { background: var(--purple); }
.hero-card.accent-red::before { background: var(--red); }
.hero-card .h-label { grid-column: 1; grid-row: 1; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; font-weight: 700; white-space: normal; word-break: break-word; text-align: left; }
.hero-card .h-value { grid-column: 2; grid-row: 1 / -1; align-self: center; justify-self: stretch; text-align: center; font-size: 26px; font-weight: 700; line-height: 1.1; letter-spacing: -0.3px; white-space: nowrap; }
.hero-card .h-sub   { grid-column: 1; grid-row: 2; font-size: 11px; color: var(--muted); font-weight: 500; white-space: normal; word-break: break-word; text-align: left; margin-top: 2px; }
.hero-card .h-delta { grid-column: 1; grid-row: 3; justify-self: start; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; margin-top: 4px; }
.h-delta.up { background: var(--pill-green-bg); color: var(--green); border: 1px solid var(--pill-green-border); }
.h-delta.down { background: var(--pill-blue-bg); color: var(--blue); border: 1px solid var(--pill-blue-border); }
.h-delta.warn { background: var(--pill-orange-bg); color: var(--orange); border: 1px solid var(--pill-orange-border); }

/* Section wrapper with clearer hierarchy */
.section-block { margin-bottom: 18px; }
.section-block > .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding: 0 2px; }
.section-block > .section-header h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--fg); margin: 0; }
.section-block > .section-header .hint { font-size: 12px; color: var(--muted); margin-left: auto; font-weight: 500; }

/* Tabs */
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap; }
.tab-btn { background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 4px 4px 0 0; transition: color .15s, border-color .15s, background .15s; }
.tab-btn:hover { color: var(--fg); background: var(--link-bg); }
.tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); font-weight: 700; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Expander */
.expander { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
.expander > summary { list-style: none; cursor: pointer; padding: 8px 12px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px; user-select: none; }
.expander > summary::-webkit-details-marker { display: none; }
.expander > summary::before { content: '▸'; color: var(--muted); font-size: 10px; transition: transform .15s; }
.expander[open] > summary::before { transform: rotate(90deg); }
.expander > summary:hover { color: var(--fg); }
.expander > summary .badge { margin-left: auto; font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--link-bg); color: var(--blue); border: 1px solid var(--link-border); font-weight: 600; }
.expander > .expander-body { padding: 0 12px 12px 12px; }

/* Insight caption under charts */
.insight { font-size: 12px; color: var(--muted); margin-top: 10px; padding: 8px 12px; background: var(--link-bg); border-left: 2px solid var(--blue); border-radius: 0 4px 4px 0; line-height: 1.5; font-weight: 500; }
.insight strong { color: var(--fg); font-weight: 700; }

/* Softer budget bar */
.budget-bar { background: var(--border); border-radius: 6px; height: 10px; overflow: hidden; position: relative; }
.budget-bar > .fill { height: 100%; border-radius: 6px; transition: width .35s ease; }

/* Two-column row for daily + hourly */
.trend-grid { display: grid; grid-template-columns: 1fr; gap: 14px; margin-bottom: 16px; }
@media (min-width: 1100px) { .trend-grid { grid-template-columns: 1.4fr 1fr; } }

/* Bento asymmetric row: side rail (More details + OTel) on LEFT, AIC big tile on RIGHT so its inner calendar sits at the far right */
.bento-row { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 18px; }
@media (min-width: 1100px) { .bento-row.aic-side { grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); } }
.bento-main { min-width: 0; }
.bento-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.bento-side .expander { margin-bottom: 0; }
.bento-row > .bento-main > .table-card:last-child { margin-bottom: 0; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left">
    <h1>
      <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>
      Copilot Usage Dashboard
    </h1>
    <div class="subtitle" id="subtitle"></div>
  </div>
  <div class="filter-bar" id="filter-bar"></div>
</div>

<!-- HERO: 4 headline KPIs -->
<div class="hero-grid" id="hero-stats"></div>

<!-- Bento row: side rail (More details + OTel) LEFT, AI Credits headline tile RIGHT so the inner calendar sits on the far right of the screen -->
<div class="bento-row aic-side">
  <div class="bento-side">
    <details class="expander" id="details-expander">
      <summary>More details <span class="badge" id="details-badge">5 metrics</span></summary>
      <div class="expander-body"><div class="stats-row" id="stats-row"></div></div>
    </details>
    <details class="expander" id="otel-expander">
      <summary>Live OpenTelemetry (diagnostic) <span class="badge" id="otel-badge">—</span></summary>
      <div class="expander-body"><div id="live-otel-section"></div></div>
    </details>
  </div>
  <div class="bento-main" id="aic-section"></div>
</div>

<!-- Usage by Source -->
<div id="agent-section"></div>

<!-- Trend charts side-by-side -->
<div class="section-block">
  <div class="section-header"><h2>Trends</h2><span class="hint">Token activity over time</span></div>
  <div class="trend-grid">
    <div class="chart-card">
      <h3>Daily Token Usage</h3>
      <div class="chart-frame chart-frame-wide"><canvas id="dailyChart"></canvas></div>
      <div class="insight" id="dailyInsight"></div>
    </div>
    <div class="chart-card">
      <div style="display:flex;align-items:center"><h3 style="flex:1" id="hourlyTitle">Average Hourly Distribution</h3><div class="tz-toggle"><button class="tz-btn active" onclick="setTz(this,'local')">Local</button><button class="tz-btn" onclick="setTz(this,'utc')">UTC</button></div></div>
      <div class="chart-frame chart-frame-wide"><canvas id="hourlyChart"></canvas></div>
      <div class="insight" id="hourlyInsight"></div>
    </div>
  </div>
</div>

<!-- BREAKDOWN: tabbed view of the same question sliced 4 ways -->
<div class="section-block">
  <div class="section-header"><h2>Breakdown</h2><span class="hint">Where did usage go?</span></div>
  <div class="table-card" style="margin-bottom:0">
    <div class="tabs" id="breakdown-tabs">
      <button class="tab-btn active" data-tab="bk-model">By Model</button>
      <button class="tab-btn" data-tab="bk-project">By Project</button>
      <button class="tab-btn" data-tab="bk-tool">By Tool</button>
      <button class="tab-btn" data-tab="bk-subagent">By Subagent</button>
    </div>
    <div class="tab-panel active" id="bk-model">
      <div class="chart-frame chart-frame-pie"><canvas id="modelChart"></canvas></div>
    </div>
    <div class="tab-panel" id="bk-project">
      <div class="chart-scroll"><div class="chart-tall" id="projectChartFrame"><canvas id="projectChart"></canvas></div></div>
    </div>
    <div class="tab-panel" id="bk-tool">
      <div class="chart-scroll"><div class="chart-tall" id="toolChartFrame"><canvas id="toolChart"></canvas></div></div>
    </div>
    <div class="tab-panel" id="bk-subagent">
      <div id="subagent-section"></div>
    </div>
  </div>
</div>

<!-- Model usage table -->
<div id="model-section"></div>

<!-- Sessions: collapsed by default since it's long -->
<details class="expander" id="sessions-expander">
  <summary>All Sessions <span class="badge" id="sessions-badge">0</span></summary>
  <div class="expander-body"><div id="sessions-section"></div></div>
</details>

<div class="note" style="margin-top:16px;text-align:center;">
  Token counts come from VS Code chatSessions files. Live OTel adds request, prompt, output, and cache-read token visibility.
</div>

<script>
let DATA = ${jsonData};
const MODEL_COLORS = ['#58a6ff','#3fb950','#bc8cff','#d29922','#f85149','#79c0ff','#f778ba','#a5d6ff'];
const RANGE_LABELS = {'7d':'Last 7 Days','30d':'Last 30 Days','90d':'Last 90 Days','tw':'This Week','tm':'This Month','pm':'Prev Month','jan':'January','feb':'February','mar':'March','apr':'April','may':'May','jun':'June','jul':'July','aug':'August','sep':'September','oct':'October','nov':'November','dec':'December','all':'All Time'};

const vscode = acquireVsCodeApi();
// Chart.js does not inherit DOM fonts — set globals once so every chart
// (bars, ticks, legends, tooltips) uses Space Grotesk to match the dashboard.
if (typeof Chart !== 'undefined' && Chart.defaults) {
  Chart.defaults.font.family = "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  Chart.defaults.font.weight = '500';
}
const _saved = vscode.getState() || {};
let selectedRange = _saved.selectedRange || 'tm';
let selectedModels = _saved.selectedModels ? new Set(_saved.selectedModels.filter(m => DATA.allModels.includes(m))) : new Set(DATA.allModels);
let selectedRefresh = typeof _saved.selectedRefresh === 'number' ? _saved.selectedRefresh : 120;
let selectedTz = _saved.selectedTz || 'local';
let charts = {};
let renderPending = false;
let renderWhenVisible = false;
function _saveState() { vscode.setState({ selectedRange, selectedRefresh, selectedModels: Array.from(selectedModels), selectedTz }); }

function fmt(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return n.toLocaleString();
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function tc(v) { return getComputedStyle(document.documentElement).getPropertyValue('--'+v).trim(); }
function mc(m) {
  const l = m.toLowerCase();
  if (l.includes('opus')) return 'model-opus';
  if (l.includes('sonnet')) return 'model-sonnet';
  if (l.includes('haiku')) return 'model-haiku';
  if (l.includes('gpt')) return 'model-gpt';
  if (l.includes('gemini')) return 'model-gemini';
  return 'model-default';
}
function getMult(model, sm) {
  if (sm && sm > 0) return sm;
  const l = model.toLowerCase();
  const mm = DATA.modelMultipliers || {};
  if (mm[l] > 0) return mm[l];
  // Substring: catch "gpt-4o-mini-2024-07-18" via catalog key "gpt-4o-mini".
  for (const [k, v] of Object.entries(mm)) { if (v > 0 && l.includes(k)) return v; }
  return 1;
}
function mbadge(m) {
  if (m >= 2) return '<span class="mult-badge mult-high">'+m+'x</span>';
  if (m < 1) return '<span class="mult-badge mult-low">'+m+'x</span>';
  return '<span class="mult-badge mult-1">'+m+'x</span>';
}
function getRangeBounds(r) {
  const now = new Date();
  // Local Y-M-D (not toISOString) so range boundaries match user's calendar day.
  const iso = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  if (r === 'all') return { start: '', end: '' };
  if (r === '7d') { const d=new Date(now); d.setDate(d.getDate()-7); return {start:iso(d),end:''}; }
  if (r === '30d') { const d=new Date(now); d.setDate(d.getDate()-30); return {start:iso(d),end:''}; }
  if (r === '90d') { const d=new Date(now); d.setDate(d.getDate()-90); return {start:iso(d),end:''}; }
  if (r === 'tw') { const d=new Date(now); const day=d.getDay(); const diff=day===0?6:day-1; d.setDate(d.getDate()-diff); return {start:iso(d),end:''}; }
  if (r === 'tm') { return {start:iso(new Date(now.getFullYear(),now.getMonth(),1)),end:''}; }
  if (r === 'pm') { const s=new Date(now.getFullYear(),now.getMonth()-1,1); const e=new Date(now.getFullYear(),now.getMonth(),0); return {start:iso(s),end:iso(e)}; }
  // Named months: jan..dec — show that month in the current year (or prev year if month > current)
  const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  if (monthMap.hasOwnProperty(r)) {
    const mi = monthMap[r];
    const yr = mi > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    const s = new Date(yr, mi, 1);
    const e = new Date(yr, mi + 1, 0);
    return {start:iso(s), end:iso(e)};
  }
  return {start:'',end:''};
}
function rangeIncludesToday(r) {
  const now = new Date();
  if (r === 'pm') return false;
  const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  if (monthMap.hasOwnProperty(r)) {
    const mi = monthMap[r];
    const yr = mi > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    return yr === now.getFullYear() && mi === now.getMonth();
  }
  return true;
}

function buildFilterBar() {
  const allCount = DATA.allModels.length;
  const selCount = selectedModels.size;
  let modelBtnText;
  if (selCount === 0) modelBtnText = 'No models';
  else if (selCount === allCount) modelBtnText = 'All Models (' + allCount + ')';
  else modelBtnText = selCount + ' of ' + allCount + ' selected';

  let modelOpts = '';
  DATA.allModels.forEach(m => {
    const chk = selectedModels.has(m) ? ' checked' : '';
    modelOpts += '<label><input type="checkbox" data-model="'+esc(m)+'"'+chk+' onchange="toggleModel(this)"><span class="model-tag '+mc(m)+'">'+esc(m)+'</span></label>';
  });

  let rangeOpts = '';
  const rangeGroups = [
    {label:'Relative', items:['7d','30d','90d','tw','tm','pm','all']},
    {label:'Month', items:['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']},
  ];
  rangeGroups.forEach(g => {
    rangeOpts += '<optgroup label="'+g.label+'">';
    g.items.forEach(r => {
      const sel = r === selectedRange ? ' selected' : '';
      rangeOpts += '<option value="'+r+'"'+sel+'>'+esc(RANGE_LABELS[r]||r)+'</option>';
    });
    rangeOpts += '</optgroup>';
  });

  let refreshOpts = '';
  [{l:'Off',v:0},{l:'Every 30s',v:30},{l:'Every 1m',v:60},{l:'Every 2m',v:120},{l:'Every 5m',v:300}].forEach(o => {
    const sel = o.v === selectedRefresh ? ' selected' : '';
    refreshOpts += '<option value="'+o.v+'"'+sel+'>'+o.l+'</option>';
  });

  let h = '';
  h += '<div class="filter-group">';
  h +=   '<span class="filter-label">Models</span>';
  h +=   '<div class="model-dd" id="model-dd">';
  h +=     '<button class="model-dd-btn" type="button" onclick="toggleModelDD(event)">'+esc(modelBtnText)+'</button>';
  h +=     '<div class="model-dd-panel" onclick="event.stopPropagation()">';
  h +=       '<div class="model-dd-actions"><button class="btn-sm" type="button" onclick="pickAll()">All</button><button class="btn-sm" type="button" onclick="pickNone()">None</button></div>';
  h +=       '<div class="model-dd-list">'+modelOpts+'</div>';
  h +=     '</div>';
  h +=   '</div>';
  h += '</div>';
  h += '<div class="filter-group">';
  h +=   '<span class="filter-label">Range</span>';
  h +=   '<select class="filter-select" id="range-select" onchange="setRangeDD(this.value)">'+rangeOpts+'</select>';
  h += '</div>';
  h += '<div class="filter-group">';
  h +=   '<span class="filter-label">Refresh</span>';
  h +=   '<select class="filter-select" id="refresh-select" onchange="setRefreshDD(parseInt(this.value,10))">'+refreshOpts+'</select>';
  h += '</div>';
  h += '<button class="btn-refresh" type="button" onclick="manualRefresh(this)" title="Refresh now">&#x21bb;</button>';

  document.getElementById('filter-bar').innerHTML = h;
}
function updateModelDDLabel() {
  const allCount = DATA.allModels.length;
  const selCount = selectedModels.size;
  let txt;
  if (selCount === 0) txt = 'No models';
  else if (selCount === allCount) txt = 'All Models (' + allCount + ')';
  else txt = selCount + ' of ' + allCount + ' selected';
  const btn = document.querySelector('#model-dd .model-dd-btn');
  if (btn) btn.textContent = txt;
}
function toggleModelDD(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('model-dd');
  if (dd) dd.classList.toggle('open');
}
document.addEventListener('click', function(e) {
  const dd = document.getElementById('model-dd');
  if (dd && dd.classList.contains('open') && !dd.contains(e.target)) {
    dd.classList.remove('open');
  }
});
function toggleModel(cb) {
  if (cb.checked) selectedModels.add(cb.dataset.model);
  else selectedModels.delete(cb.dataset.model);
  _saveState(); updateModelDDLabel(); queueRender();
}
function pickAll() {
  DATA.allModels.forEach(m => selectedModels.add(m));
  document.querySelectorAll('#model-dd input[type="checkbox"]').forEach(c => c.checked = true);
  _saveState(); updateModelDDLabel(); queueRender();
}
function pickNone() {
  selectedModels.clear();
  document.querySelectorAll('#model-dd input[type="checkbox"]').forEach(c => c.checked = false);
  _saveState(); updateModelDDLabel(); queueRender();
}
function setRangeDD(r) {
  selectedRange = r;
  _saveState();
  // Auto-refresh awareness: disable when range doesn't include today
  if (!rangeIncludesToday(r) && selectedRefresh > 0) {
    selectedRefresh = 0;
    _saveState();
    vscode.postMessage({type:'refreshRate',intervalMs:0});
    syncRefreshSelect();
  } else if (rangeIncludesToday(r) && selectedRefresh === 0) {
    selectedRefresh = 120;
    _saveState();
    vscode.postMessage({type:'refreshRate',intervalMs:120000});
    syncRefreshSelect();
  }
  queueRender();
}
function syncRefreshSelect() {
  const sel = document.getElementById('refresh-select');
  if (sel) sel.value = String(selectedRefresh);
}
function setTz(btn, tz) { selectedTz=tz; btn.closest('.tz-toggle').querySelectorAll('.tz-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); _saveState(); queueRender(); }
function setRefreshDD(secs) {
  selectedRefresh = secs;
  _saveState();
  vscode.postMessage({type:'refreshRate',intervalMs:secs*1000});
}
function manualRefresh(btn) { vscode.postMessage({type:'manualRefresh'}); }

function queueRender() {
  if (document.hidden) {
    renderWhenVisible = true;
    return;
  }
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
    requestAnimationFrame(resizeCharts);
  });
}

function resizeCharts() {
  Object.values(charts).forEach(c => { if (c) c.resize(); });
}

function render() {
  const bounds = getRangeBounds(selectedRange);
  const sessions = DATA.sessionsAll.filter(s => selectedModels.has(s.model) && (!bounds.start || s.lastDate >= bounds.start) && (!bounds.end || s.lastDate <= bounds.end));
  const sids = new Set(sessions.map(s=>s.sessionId));
  const daily = DATA.dailyByModel.filter(d => selectedModels.has(d.model) && (!bounds.start || d.day >= bounds.start) && (!bounds.end || d.day <= bounds.end));
  const tools = DATA.toolsAll.filter(t => sids.has(t.sessionId));
  const subs = DATA.subagentsAll.filter(s => sids.has(s.sessionId));
  const turns = DATA.turnsAll.filter(t => selectedModels.has(t.model) && (!bounds.start || t.timestamp.slice(0,10) >= bounds.start) && (!bounds.end || t.timestamp.slice(0,10) <= bounds.end));

  const t = {
    sessions: sessions.length,
    turns: sessions.reduce((s,x)=>s+x.turns,0),
    prompt: sessions.reduce((s,x)=>s+(x.actualPrompt||x.prompt),0),
    output: sessions.reduce((s,x)=>s+(x.actualOutput||x.output),0),
    cached: sessions.reduce((s,x)=>s+(x.actualCached||0),0),
    tools: tools.reduce((s,x)=>s+x.count,0),
    subs: subs.reduce((s,x)=>s+x.count,0),
    premium: sessions.reduce((s,x)=>s+getMult(x.modelName,x.multiplier)*x.turns,0),
  };

  const rl = RANGE_LABELS[selectedRange] || selectedRange;
  const refreshStatus = selectedRefresh > 0 ? '' : ' (auto-refresh off)';
  document.getElementById('subtitle').textContent = 'Updated: '+DATA.generatedAt+' — '+rl+refreshStatus;

  // Authoritative per-day credit map for the selected range. aic.byDay is
  // built from computeSummary(creditEntries) and already includes every
  // source (VS Code turns + live OTel overlay + OMP + Pi + CLI), so the
  // dashboard reconciles with the sidebar. Session fallback fills days
  // outside the current billing cycle (past months where byDay is empty).
  const rangeAicDayMap = {};
  (DATA.aicSummary && DATA.aicSummary.byDay || []).forEach(d => {
    if ((!bounds.start || d.day >= bounds.start) && (!bounds.end || d.day <= bounds.end)) {
      rangeAicDayMap[d.day] = d.credits;
    }
  });
  sessions.forEach(s => {
    if (s.lastDate && s.aicCredits && !(s.lastDate in rangeAicDayMap)) {
      rangeAicDayMap[s.lastDate] = (rangeAicDayMap[s.lastDate] || 0) + s.aicCredits;
    }
  });
  const rangeAicTotal = Object.values(rangeAicDayMap).reduce((s, v) => s + v, 0);
  const aicTotal = rangeAicTotal.toFixed(1);
  const aicBudget = DATA.aicSummary ? DATA.aicSummary.monthlyBudget : 0;
  const ag = DATA.agentSummary;
  const aicSub = aicBudget > 0 ? aicTotal+'/'+aicBudget+' credits' : 'no budget set';
  const aicSrcSub = (ag && (ag.ompSessions > 0 || ag.piSessions > 0 || ag.cliSessions > 0))
    ? 'VS Code+OMP+Pi+CLI (all sources)'
    : aicSub;

  // === HERO KPIs (4 headline cards with deltas & accent stripes) ===
  const heroActiveDayCount = Object.keys(rangeAicDayMap).length || 1;
  const heroDailyAvg = rangeAicTotal / heroActiveDayCount;

  // Only project/runway when the selected range is live (includes today).
  // For closed periods (Prev Month, a past named month), projection & runway
  // are meaningless — the period is done.
  const rangeIsLive = rangeIncludesToday(selectedRange);
  // For the default 'This Month' range use aic.projectedTotal directly so
  // the number matches the sidebar's pace card (same all-source basis).
  const heroProjected = rangeIsLive && DATA.aicSummary && DATA.aicSummary.daysRemaining > 0
    ? (selectedRange === 'tm'
        ? DATA.aicSummary.projectedTotal
        : DATA.aicSummary.totalCredits + (heroDailyAvg * DATA.aicSummary.daysRemaining))
    : rangeAicTotal;

  let runwayTxt = '';
  if (rangeIsLive && DATA.aicSummary && DATA.aicSummary.monthlyBudget > 0 && heroDailyAvg > 0) {
    const remaining = DATA.aicSummary.monthlyBudget - DATA.aicSummary.totalCredits;
    const days = Math.max(0, Math.floor(remaining / heroDailyAvg));
    runwayTxt = days + ' days runway at current pace';
  } else if (!rangeIsLive) {
    runwayTxt = 'closed period';
  }
  const projPct = rangeIsLive && DATA.aicSummary && DATA.aicSummary.monthlyBudget > 0
    ? Math.round((heroProjected / DATA.aicSummary.monthlyBudget) * 100)
    : 0;
  const spendDelta = projPct >= 100
    ? '<span class="h-delta warn">↑ projecting '+projPct+'% of budget</span>'
    : projPct > 0
    ? '<span class="h-delta up">on track · '+projPct+'% projected</span>'
    : '';
  const turnsPerSess = t.sessions > 0 ? (t.turns/t.sessions).toFixed(1) : '0';
  const tokensTotal = t.prompt + t.output;
  const tokensPerTurn = t.turns > 0 ? fmt(Math.round(tokensTotal/t.turns)) : '0';

  // === HERO KPIs (redesigned v1.10.26) ===
  // Removed duplicates: "Tokens Processed" (was just Prompt+Output shown below),
  // and Activity subtitle "N tool calls · M subagents" (was duplicating More
  // Details tiles). New card set surfaces the money numbers the user actually
  // cares about — spend, overage, pace, projection — all range-scoped and
  // consistent (sum reconciles across the whole page).
  const promo = DATA.aicSummary?.promo || {};
  const isPromo = promo.isPromoActive && promo.promoBudget > 0;
  const overageCost = DATA.aicSummary?.config?.overageCostPerCredit ?? 0.01;
  const effectiveBudget = isPromo ? promo.promoBudget : (DATA.aicSummary?.monthlyBudget || 0);
  const rangeOverageDollars = effectiveBudget > 0
    ? Math.max(0, rangeAicTotal - effectiveBudget) * overageCost
    : 0;
  const overageLabel = isPromo ? 'Overage (with promo)' : 'Overage';
  const overageSub = effectiveBudget > 0
    ? '@ $' + overageCost + '/credit over ' + effectiveBudget + ' budget'
    : 'no budget set';
  const paceSub = heroActiveDayCount + ' active day' + (heroActiveDayCount === 1 ? '' : 's');
  const projectedValue = rangeIsLive ? Math.round(heroProjected).toLocaleString() : rangeAicTotal.toFixed(0);
  const projectedSub = rangeIsLive ? 'end of cycle' : 'range total (closed)';
  const projectedAccent = rangeIsLive && projPct >= 100 ? 'orange' : rangeIsLive && projPct >= 80 ? 'orange' : 'green';

  document.getElementById('hero-stats').innerHTML = [
    {l:'AI Credits Spent', v:aicTotal,                              sub: rl + ' · ' + t.sessions + ' sessions · ' + t.turns + ' turns', accent:'orange', delta:spendDelta},
    {l:overageLabel,       v:'$'+rangeOverageDollars.toFixed(2),    sub: overageSub, accent:'red', delta:''},
    // Cache Hit formula MUST match cache.ts (single source of truth). The
    // arithmetic is inlined here only because the aggregate is built from a
    // user-selected range at render time — extension host can't pre-compute
    // every possible range. Formula: cached / prompt (Copilot's prompt
    // already includes cached — see aicCredits.ts:452). Tiers: ≥80 excellent,
    // ≥30 ok, else cold.
    {l:'Cache Hit',        v:(t.prompt>0?(t.cached/t.prompt*100).toFixed(1)+'%':'—'),
                                                                     sub: (t.cached>0?fmt(t.cached)+' cached / '+fmt(t.prompt)+' prompt':'no cache data'),
                                                                     accent:'green', delta:''},
    {l:'Daily Pace',       v:Math.round(heroDailyAvg).toLocaleString(), sub: paceSub, accent:'', delta:'<span class="h-delta up">'+turnsPerSess+' turns/sess · '+tokensPerTurn+' tok/turn</span>'},
    {l:'Projected',        v:projectedValue,                        sub: projectedSub, accent:projectedAccent, delta:''},
  ].map(c=>'<div class="hero-card'+(c.accent?' accent-'+c.accent:'')+'"><div class="h-label">'+c.l+'</div><div class="h-value">'+c.v+'</div><div class="h-sub">'+c.sub+'</div>'+(c.delta||'')+'</div>').join('');

  // === Secondary metrics (Prompt/Output/Tools/Subagents — kept here but the
  // authoritative TOTAL row also appears in Usage-by-Model. Mirrors/Transcripts
  // are internal scan diagnostics and belong under a "Diagnostics" collapsed
  // section, not the KPI grid.
  const detailsCards = [
    {l:'Prompt Tokens', v:fmt(t.prompt), s:'input to models'},
    {l:'Output Tokens', v:fmt(t.output), s:'generated tokens'},
    {l:'Tool Calls',    v:fmt(t.tools), s:'all tool invocations'},
    {l:'Subagent Calls',v:t.subs, s:'runSubagent only'},
    {l:'Mirrors',       v:DATA.scanStats.mirroredSessions, s:DATA.scanStats.mirrorCopiesPruned+' pruned · diagnostic'},
    {l:'Transcripts',   v:DATA.scanStats.transcriptsFound, s:DATA.scanStats.promptPreviews+' with previews · diagnostic'},
  ];
  document.getElementById('stats-row').innerHTML = detailsCards.map(c=>'<div class="stat-card"><div class="label">'+c.l+'</div><div class="value">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('');
  const dBadge = document.getElementById('details-badge');
  if (dBadge) dBadge.textContent = detailsCards.length + ' metrics';

  // Update expander badges
  const sBadge = document.getElementById('sessions-badge');
  if (sBadge) sBadge.textContent = sessions.length + ' sessions';
  const oBadge = document.getElementById('otel-badge');
  if (oBadge) {
    oBadge.textContent = (DATA.liveOtel && DATA.liveOtel.requests)
      ? DATA.liveOtel.requests + ' requests'
      : 'no data';
  }

  renderOtel(DATA.liveOtel);
  renderAIC(DATA.aicSummary, bounds, sessions);
  renderAgentSessions(DATA.agentSummary, bounds, sessions, rangeAicTotal);
  renderDaily(daily);
  renderModelPie(sessions);
  renderProjectBar(sessions);
  renderToolBar(tools);
  renderSessions(sessions, subs);
  renderModelTable(sessions);
  renderSubagents(subs);
  renderHourly(turns);
}

function renderOtel(live) {
  const el = document.getElementById('live-otel-section');
  if (!live || !live.requests) {
    el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">Live OpenTelemetry</div><div class="section-subtitle">Waiting for Copilot telemetry</div></div><div class="empty-panel">No live OTLP events yet. If global telemetry stays off, the dashboard can still use debug-log based historical activity after chat turns are written to disk.</div></div>';
    return;
  }
  const ls = live.lastSeen ? new Date(live.lastSeen).toLocaleString('en-CA', {hour12: false}).replace(',','') : '';
  const csub = live.metricCached ? 'using metric deltas' : 'trace fallback only';
  const sourceLabel = live.source === 'debug-log' ? 'Live (debug-log stream • API-exact)' : 'Live OTLP receiver';
  const reqLabel = live.source === 'debug-log' ? 'LLM Requests' : 'OTel Requests';
  const debugNote = 'Streaming directly from the local debug-log (<code>main.jsonl</code>) — the same <code>copilotUsageNanoAiu</code> the API bills you for. The OTLP receiver port (14318) is held by another VS Code window, so live OTLP traces are routed there; this window watches the debug-log file for real-time updates instead. Values are <strong>exact</strong>, not estimated.';
  let rows = '';
  (live.byModel||[]).forEach(m => {
    const aic = (m.aicCredits || 0);
    // Hit rate is pre-computed in dashboardData.ts (see cache.ts).
    const hit = m.prompt > 0 ? (m.cacheHitPct || 0).toFixed(1) + '%' : '—';
    // 2dp matches the storage precision (copilotUsageNanoAiu / 1e9 rounded to
    // 2dp by dashboardData.ts); .toFixed(1) was silently hiding cents — e.g. a
    // 7.22-credit request rendered as 7.2.
    rows += '<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span></td><td class="num">'+m.requests+'</td><td class="num">'+fmt(m.prompt)+'</td><td class="num">'+fmt(m.completion)+'</td><td class="num">'+fmt(m.traceCached)+'</td><td class="num">'+fmt(m.metricCached)+'</td><td class="num cached">'+fmt(m.cached)+'</td><td class="num cached">'+hit+'</td><td class="num orange">'+aic.toFixed(2)+'</td></tr>';
  });
  // AIC (sess) sub-text: when the classifier excluded non-billable byModel
  // rows (Ollama / BYOK / unknown), show their sum so the user can SEE the
  // gap between the headline session total and the per-model table below
  // instead of mysteriously dropping value (root cause of v1.10.13 user-
  // visible "AIC SESS = 0.00 but rows show 70.96" bug).
  const infoAic = +(live.informationalAIC || 0);
  const sessSub = infoAic > 0 ? 'session total · +' + infoAic.toFixed(2) + ' informational' : 'session total';
  // Cache-hit rate — pre-computed in dashboardData.ts. Tier thresholds match
  // cache.ts (excellent ≥ 80, ok ≥ 30). Never inline the arithmetic here —
  // it must stay in one place to prevent surface-to-surface drift.
  const hitPct = live.cacheHitPct || 0;
  const hitSub = hitPct >= 80 ? 'excellent reuse' : hitPct >= 30 ? 'some reuse' : 'cold cache';
  el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">Live OpenTelemetry</div><div class="section-subtitle">'+esc(sourceLabel)+' • Last event '+esc(ls)+'</div></div>'
    +'<div class="note">'+(live.source === 'debug-log' ? debugNote : 'Live OTLP export. Cached tokens prefer cumulative metric deltas when available.')+'</div>'
    +'<div class="stats-row">'
    +[reqLabel+':'+live.requests+':last event '+esc(ls),'Live Prompt:'+fmt(live.prompt)+':from traces','Live Output:'+fmt(live.completion)+':from traces','Live Cached:'+fmt(live.cached)+':'+csub,'Cache Hit:'+hitPct.toFixed(1)+'%:'+hitSub,'Trace Cache:'+fmt(live.traceCached)+':cache_read','Metric Cache:'+fmt(live.metricCached)+':token.usage','AIC (sess):'+((live.sessionAIC||0).toFixed(2))+':'+sessSub,'AIC (last req):'+ ((live.lastRequestAIC||0).toFixed(2))+':last request']
      .map((s,i)=>{const p=s.split(':');return '<div class="stat-card"><div class="label">'+p[0]+'</div><div class="value'+(i===3||i===4?' cached':i>=7?' orange':'')+'">'+p[1]+'</div><div class="sub">'+p[2]+'</div></div>';}).join('')
    +'</div>'
    +'<div class="section-title" style="margin-top:8px">Live OTel by Model</div>'
    +'<div class="table-scroll"><table><thead><tr><th>Model</th><th class="num">Reqs</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Trace</th><th class="num">Metric</th><th class="num">Cached</th><th class="num">Hit %</th><th class="num">AIC</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
}

/**
 * Build a calendar grid showing daily AI Credits for the current billing cycle.
 * Each cell is color-coded by intensity. Shows the full month with
 * day-of-week headers (Mon-Sun).
 */
function buildCreditCalendar(cycleStart, cycleEnd, dayMap) {
  // Determine the month to display (from billing cycle start)
  const startDate = new Date(cycleStart + 'T00:00:00');
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  const monthName = startDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Get first day of month and total days
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = (firstOfMonth.getDay() + 6) % 7; // Monday=0

  // Collect credits for this month and find max for color scaling
  const monthCredits = [];
  let maxCredits = 0;
  let totalMonth = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const cr = dayMap[dateStr] || 0;
    monthCredits.push({ day: d, date: dateStr, credits: cr });
    if (cr > maxCredits) { maxCredits = cr; }
    totalMonth += cr;
  }

  // Today marker — use LOCAL Y-M-D so it matches the cycle/calendar dates,
  // which are now serialized in local time (issue #2). Using toISOString()
  // here would re-introduce the off-by-one for users east of UTC.
  const _now = new Date();
  const todayStr = _now.getFullYear() + '-'
    + String(_now.getMonth() + 1).padStart(2, '0') + '-'
    + String(_now.getDate()).padStart(2, '0');

  // Build grid: 7 columns (Mon-Sun), enough rows for the month
  const dayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let headerRow = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px">';
  dayHeaders.forEach(dh => {
    headerRow += '<div style="text-align:center;font-size:9px;color:var(--muted);font-weight:600">'+dh+'</div>';
  });
  headerRow += '</div>';

  let gridCells = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">';

  // Empty cells before first day
  for (let i = 0; i < startDow; i++) {
    gridCells += '<div style="aspect-ratio:1;border-radius:4px"></div>';
  }

  // Day cells
  for (let i = 0; i < daysInMonth; i++) {
    const mc = monthCredits[i];
    const intensity = maxCredits > 0 ? mc.credits / maxCredits : 0;
    const isToday = mc.date === todayStr;
    const isFuture = mc.date > todayStr;

    // Color: green gradient for usage intensity, gray for zero, dimmed for future
    let bg, border, textColor;
    if (isFuture) {
      bg = 'var(--border)';
      border = 'none';
      textColor = 'var(--muted)';
    } else if (mc.credits === 0) {
      bg = 'rgba(255,255,255,0.03)';
      border = '1px solid var(--border)';
      textColor = 'var(--muted)';
    } else if (intensity > 0.8) {
      bg = 'rgba(48,209,88,0.82)';
      border = '1px solid rgba(48,209,88,0.95)';
      textColor = '#fff';
    } else if (intensity > 0.5) {
      bg = 'rgba(48,209,88,0.52)';
      border = '1px solid rgba(48,209,88,0.72)';
      textColor = '#fff';
    } else if (intensity > 0.2) {
      bg = 'rgba(255,159,10,0.55)';
      border = '1px solid rgba(255,159,10,0.75)';
      textColor = '#fff';
    } else {
      bg = 'rgba(255,69,58,0.35)';
      border = '1px solid rgba(255,69,58,0.55)';
      textColor = 'var(--fg)';
    }

    const todayOutline = isToday ? ';outline:2px solid var(--blue);outline-offset:-1px' : '';
    const tooltip = mc.date + ': ' + mc.credits.toFixed(1) + ' credits';
    const creditsLabel = mc.credits > 0 ? '<div style="font-size:8px;color:'+textColor+';opacity:0.9">'+mc.credits.toFixed(1)+'</div>' : '';

    gridCells += '<div title="'+tooltip+'" style="aspect-ratio:1;border-radius:4px;background:'+bg+';border:'+border+';display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:default'+todayOutline+'">'
      + '<div style="font-size:10px;font-weight:600;color:'+textColor+'">'+mc.day+'</div>'
      + creditsLabel
      + '</div>';
  }

  gridCells += '</div>';

  // Legend
  const legend = '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:9px;color:var(--muted)">'
    + '<span>Less</span>'
    + '<div style="width:10px;height:10px;border-radius:2px;background:rgba(255,69,58,0.35)"></div>'
    + '<div style="width:10px;height:10px;border-radius:2px;background:rgba(255,159,10,0.55)"></div>'
    + '<div style="width:10px;height:10px;border-radius:2px;background:rgba(48,209,88,0.52)"></div>'
    + '<div style="width:10px;height:10px;border-radius:2px;background:rgba(48,209,88,0.82)"></div>'
    + '<span>More</span>'
    + '<span style="margin-left:auto">Month total: <strong style="color:var(--orange)">'+totalMonth.toFixed(1)+'</strong> credits</span>'
    + '</div>';

  return '<div class="section-title" style="margin-bottom:6px">Daily Credits — '+monthName+'</div>'
    + headerRow + gridCells + legend;
}

function renderAIC(aic, bounds, filteredSessions) {
  const el = document.getElementById('aic-section');
  if (!aic || aic.totalCredits === 0) {
    el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">AI Credits (AIC)</div><div class="section-subtitle">No usage data yet</div></div><div class="empty-panel">AI Credits will be calculated once token usage data is available. Configure your plan in Settings → Copilot Usage.</div></div>';
    return;
  }

  // Build authoritative per-day credit map first. aic.byDay already blends
  // VS Code turns + live OTel overlay + OMP + Pi + CLI (from
  // computeSummary(creditEntries)), so summing it makes this section
  // reconcile with the sidebar. Session aggregation fills days outside the
  // current cycle (past months where byDay is empty).
  const sessionDayMap = {};
  filteredSessions.forEach(s => {
    if (s.lastDate && s.aicCredits) {
      sessionDayMap[s.lastDate] = (sessionDayMap[s.lastDate] || 0) + s.aicCredits;
    }
  });
  const filteredByDay = (aic.byDay||[]).filter(d => (!bounds.start || d.day >= bounds.start) && (!bounds.end || d.day <= bounds.end));
  const finalDayMap = {};
  filteredByDay.forEach(d => { finalDayMap[d.day] = d.credits; });
  Object.entries(sessionDayMap).forEach(([day, credits]) => {
    if (!(day in finalDayMap)) { finalDayMap[day] = credits; }
  });
  const rangeTotal = Object.values(finalDayMap).reduce((s, v) => s + v, 0);

  // Daily average from days that actually had activity — accurate for any range.
  const activeDayCount = Object.keys(finalDayMap).length || 1;
  const rangeDailyAvg = rangeTotal / activeDayCount;

  // Projection only makes sense when the range is live (includes today).
  // For the 'This Month' default use aic.projectedTotal directly so the
  // number matches the sidebar's pace card (same all-source basis).
  const aicRangeIsLive = rangeIncludesToday(selectedRange);
  const rangeProjected = aicRangeIsLive && aic.daysRemaining > 0
    ? (selectedRange === 'tm'
        ? aic.projectedTotal
        : aic.totalCredits + (rangeDailyAvg * aic.daysRemaining))
    : rangeTotal;

  const pct = aic.monthlyBudget > 0 ? Math.min(100, Math.round((rangeTotal / aic.monthlyBudget) * 100)) : 0;
  const pctActual = aic.monthlyBudget > 0 ? Math.round((rangeTotal / aic.monthlyBudget) * 100) : 0;
  // Calmer thresholds: blue→green→amber→red, only red when actually past budget
  const barColor = pctActual >= 100 ? 'var(--red)' : pctActual >= 85 ? 'var(--orange)' : pctActual >= 50 ? 'var(--green)' : 'var(--blue)';
  const projPct = aicRangeIsLive && aic.monthlyBudget > 0 ? Math.round((rangeProjected / aic.monthlyBudget) * 100) : 0;
  const projColor = projPct >= 100 ? 'var(--red)' : projPct >= 80 ? 'var(--orange)' : 'var(--green)';

  // Runway: only meaningful for live ranges (past periods are closed)
  const runwayDays = aicRangeIsLive && rangeDailyAvg > 0
    ? Math.max(0, Math.floor((aic.monthlyBudget - aic.totalCredits) / rangeDailyAvg))
    : 0;

  // Promo info
  const promo = aic.promo || {};
  const isPromo = promo.isPromoActive && promo.promoBudget > 0;
  const planLabel = aic.planName.charAt(0).toUpperCase() + aic.planName.slice(1).replace('_', ' ');
  const promoTag = isPromo ? ' <span style="color:var(--green);font-size:11px;font-weight:600">⚡ PROMO (until '+promo.promoEndDate+')</span>' : '';

  // Budget progress bar
  const runwayBadge = !aicRangeIsLive
    ? ' · <span style="color:var(--muted)">closed period</span>'
    : runwayDays > 0
      ? ' · <span style="color:var(--green)">~'+runwayDays+' days runway</span>'
      : (rangeDailyAvg > 0 ? ' · <span style="color:var(--orange)">over budget pace</span>' : '');
  const overCredits = rangeTotal - aic.monthlyBudget;
  const pctLabel = pctActual > 100
    ? '<span style="font-weight:700;color:var(--red)" title="'+overCredits.toFixed(1)+' credits over '+aic.monthlyBudget+' budget">'+pctActual+'% <span style="font-weight:500;font-size:10px;opacity:0.85">(+'+(pctActual-100)+'% over)</span></span>'
    : '<span style="font-weight:600;color:var(--fg)">'+pctActual+'%</span>';
  const budgetBar = aic.monthlyBudget > 0
    ? '<div style="margin:14px 0"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:6px"><span>'+rangeTotal.toFixed(1)+' / '+aic.monthlyBudget+' credits used'+( isPromo ? ' (promo)' : '')+runwayBadge+'</span>'+pctLabel+'</div><div class="budget-bar"><div class="fill" style="width:'+pct+'%;background:'+barColor+'"></div></div></div>'
    : '';

  // Stats row — uses range-filtered values.
  // For historical ranges we cannot compute input/output/cached credit split
  // (that data only exists in aic.byModel for the current cycle), so we show
  // prompt-token volume instead — always accurate and derived from sessions.
  const rangePromptTokens = filteredSessions.reduce((s,x) => s + (x.actualPrompt||x.prompt||0), 0);
  const projectedSub = aicRangeIsLive ? 'end of cycle' : 'range total (closed)';
  // Gross value = every credit at face rate, with no budget subtracted — shown
  // as a sub-line so it's never mistaken for the Overage cards below, which
  // bill only the credits that exceed your plan's included allowance.
  const overageCost = aic.config ? aic.config.overageCostPerCredit : 0.01;
  const rangeGrossValue = rangeTotal * overageCost;
  const statsCards = [
    {l:'Total Credits',v:rangeTotal.toFixed(1),s:planLabel+' plan · $'+rangeGrossValue.toFixed(2)+' gross value',c:'orange'},
    {l:'Prompt Tokens',v:fmt(rangePromptTokens),s:'input to models'},
    {l:'Daily Avg',v:rangeDailyAvg.toFixed(1),s:activeDayCount+' active day'+(activeDayCount===1?'':'s')},
    {l:'Projected',v:rangeProjected.toFixed(0),s:projectedSub,c:aicRangeIsLive && projPct>=100?'red':aicRangeIsLive && projPct>=80?'orange':''},
  ];

  // Overage card(s): recalculate from range-filtered total. "Overage" bills
  // only credits ABOVE the included budget (1900/3000), not the gross value
  // above — e.g. 27068 credits - 1900 included = 25168 billable * $0.01.
  let overageHTML = '';
  if (isPromo) {
    const rangeOverageWithPromo = Math.max(0, rangeTotal - promo.promoBudget) * overageCost;
    const rangeOverageWithoutPromo = Math.max(0, rangeTotal - (promo.standardBudget||0)) * overageCost;
    const rangePromoSavings = rangeOverageWithoutPromo - rangeOverageWithPromo;
    overageHTML = '<div class="stats-row" style="margin-top:8px">'
      + '<div class="stat-card" style="border-left:3px solid var(--green)"><div class="label">Overage (With Promo)</div><div class="value'+(rangeOverageWithPromo > 0?' red':'')+'">$'+rangeOverageWithPromo.toFixed(2)+'</div><div class="sub">budget: '+promo.promoBudget+' credits</div></div>'
      + '<div class="stat-card" style="border-left:3px solid var(--orange)"><div class="label">Overage (Without Promo)</div><div class="value'+(rangeOverageWithoutPromo > 0?' red':'')+'">$'+rangeOverageWithoutPromo.toFixed(2)+'</div><div class="sub">standard: '+(promo.standardBudget||0)+' credits</div></div>'
      + '<div class="stat-card" style="border-left:3px solid var(--green)"><div class="label">Promo Savings</div><div class="value green">$'+rangePromoSavings.toFixed(2)+'</div><div class="sub">ends '+promo.promoEndDate+'</div></div>'
      + '</div>';
  } else {
    const rangeOverage = Math.max(0, rangeTotal - aic.monthlyBudget) * overageCost;
    overageHTML = '<div class="stats-row" style="margin-top:8px">'
      + '<div class="stat-card"><div class="label">Overage Cost</div><div class="value'+(rangeOverage > 0?' red':'')+'">$'+rangeOverage.toFixed(2)+'</div><div class="sub">@ $'+overageCost+'/credit</div></div>'
      + '</div>';
  }

  // Model breakdown table — computed from range-filtered sessions.
  // For the current billing cycle we have per-request input/output/cached
  // splits (in aic.byModel). For historical ranges we only have session-level
  // total credits — so we render em-dash in the split columns to avoid showing
  // misleading 0.00 values.
  const useOriginalByModel = !bounds.start || (bounds.start <= aic.billingCycleStart && (!bounds.end || bounds.end >= aic.billingCycleEnd));
  let modelRows = '';
  if (useOriginalByModel) {
    (aic.byModel||[]).forEach(m => {
      const tierBadge = m.tier === 'premium' ? '<span class="mult-badge mult-high">premium</span>' : m.tier === 'base' ? '<span class="mult-badge mult-1">base</span>' : '<span class="mult-badge">custom</span>';
      modelRows += '<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span> '+tierBadge+'</td><td class="num">'+m.inputCredits.toFixed(2)+'</td><td class="num">'+m.outputCredits.toFixed(2)+'</td><td class="num cached">'+m.cachedCredits.toFixed(2)+'</td><td class="num orange">'+m.totalCredits.toFixed(2)+'</td></tr>';
    });
  } else {
    // Historical range: aggregate session credits by model, no split available
    const modelTotals = {};
    const tierMap = {};
    (aic.byModel||[]).forEach(bm => { tierMap[bm.model] = bm.tier; });
    filteredSessions.forEach(s => {
      const m = s.model || s.modelName || 'unknown';
      modelTotals[m] = (modelTotals[m] || 0) + (s.aicCredits || 0);
    });
    Object.entries(modelTotals)
      .filter(([,total]) => total > 0)
      .sort((a,b) => b[1] - a[1])
      .forEach(([m, total]) => {
        const tier = tierMap[m] || '';
        const tierBadge = tier === 'premium' ? '<span class="mult-badge mult-high">premium</span>' : tier === 'base' ? '<span class="mult-badge mult-1">base</span>' : '<span class="mult-badge">custom</span>';
        modelRows += '<tr><td><span class="model-tag '+mc(m)+'">'+esc(m)+'</span> '+tierBadge+'</td><td class="num" style="color:var(--muted)">—</td><td class="num" style="color:var(--muted)">—</td><td class="num" style="color:var(--muted)">—</td><td class="num orange">'+total.toFixed(2)+'</td></tr>';
      });
  }

  // Daily credits calendar — finalDayMap built above already merges aic.byDay
  // (authoritative, current cycle) with session-derived data (any month).
  const calStart = bounds.start || aic.billingCycleStart;
  const calEnd = bounds.end || aic.billingCycleEnd;
  const calendarHTML = buildCreditCalendar(calStart, calEnd, finalDayMap);

  // Estimation note
  const cacheNote = aic.isActualFromApi
    ? '<div style="margin-top:8px;padding:6px 10px;background:var(--border);border-radius:4px;font-size:10px;color:#4ec9b0">✓ <strong>Actual billing data:</strong> Credits sourced from API-reported copilotUsageNanoAiu per request. Includes cache discounts.</div>'
    : aic.cachedCredits === 0
    ? '<div style="margin-top:8px;padding:6px 10px;background:var(--border);border-radius:4px;font-size:10px;color:var(--muted)">⚠️ <strong>Estimate:</strong> Computed from published per-model rates. Does not include cache-write costs (~5-10% undercount for Anthropic models). Check GitHub billing for exact usage.</div>'
    : '';

  // Non-billable models panel (issue #5)
  // Surfaces local Ollama / LM Studio / BYOK / unrecognised model usage as
  // informational rows so users can see capacity-planning numbers without
  // those rows inflating the billed total above. Values are AI credits
  // (1 credit = $0.01): the provider's own billed cost where the agent
  // ledger supplies one, a Copilot rate-table estimate otherwise.
  let nonBillableHTML = '';
  const nb = aic.nonBillable;
  if (nb) {
    // Re-aggregate from the per-day rows so this panel honours the selected
    // range like every table above it. nb.byModel is whole-cycle and is only
    // used as a fallback for payloads that predate nb.byDay.
    const nbAgg = {};
    let nbTotal = 0;
    if (nb.byDay && nb.byDay.length) {
      nb.byDay
        .filter(d => (!bounds.start || d.day >= bounds.start) && (!bounds.end || d.day <= bounds.end))
        .forEach(d => {
          const row = nbAgg[d.model] || (nbAgg[d.model] = {model:d.model,tier:d.tier,inputCredits:0,outputCredits:0,cachedCredits:0,totalCredits:0});
          row.inputCredits += d.inputCredits;
          row.outputCredits += d.outputCredits;
          row.cachedCredits += d.cachedCredits;
          row.totalCredits += d.totalCredits;
          nbTotal += d.totalCredits;
        });
    } else if (useOriginalByModel) {
      (nb.byModel||[]).forEach(m => { nbAgg[m.model] = m; });
      nbTotal = nb.totalCredits;
    }
    // Drop zero-credit rows — token-less requests (e.g. a cancelled turn on an
    // unrecognised model) otherwise render as pure "0.00" noise.
    const nbVisible = Object.values(nbAgg)
      .filter(m => m.totalCredits >= 0.005)
      .sort((a, b) => b.totalCredits - a.totalCredits);
    if (nbVisible.length > 0) {
      let nbRows = '';
      nbVisible.forEach(m => {
        const tierBadge = m.tier === 'premium'
          ? '<span class="mult-badge mult-high">premium</span>'
          : m.tier === 'base'
            ? '<span class="mult-badge mult-1">base</span>'
            : '<span class="mult-badge">custom</span>';
        nbRows += '<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span> '+tierBadge+'</td>'
          + '<td class="num">'+m.inputCredits.toFixed(2)+'</td>'
          + '<td class="num">'+m.outputCredits.toFixed(2)+'</td>'
          + '<td class="num cached">'+m.cachedCredits.toFixed(2)+'</td>'
          + '<td class="num" style="color:var(--muted)">'+m.totalCredits.toFixed(2)+'</td></tr>';
      });
      nonBillableHTML = '<div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--border)">'
        + '<div class="section-title" style="margin-bottom:6px">Non-billable models (informational)</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">'
        + 'GitHub Copilot does <strong>not</strong> bill these models — they appear here only so you can see local Ollama, LM Studio, BYOK, or unrecognised model traffic, and they are <strong>excluded from the billed total above</strong>. '
        + 'Numbers are AI credits, not tokens (1 credit = $0.01). For agent sessions the total is the <em>cost billed by the provider itself</em>; where no provider cost is recorded it is a Copilot rate-table estimate. The input/output/cached split is apportioned from token counts. '
        + 'Toggle <code>copilotUsage.aic.includeOnlyBilledModels</code> off to restore legacy behaviour.'
        + '</div>'
        + '<table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">Total (credits)</th></tr></thead><tbody>'
        + nbRows
        + '</tbody><tfoot><tr><td colspan="4" style="text-align:right;color:var(--muted)">Non-billable total (informational):</td><td class="num" style="color:var(--muted)"><strong>'+nbTotal.toFixed(2)+'</strong></td></tr></tfoot></table>'
        + '</div>';
    }
  }

  // ── Systems (cross-machine rollups shared over Settings Sync) ──────────
  // Rendered only when a second machine has reported, since a one-row table
  // just repeats the headline numbers. The headline tiles above stay strictly
  // machine-local so they remain reconcilable against a single local source.
  let systemsHTML = '';
  const machines = (DATA.machines || []).filter(m => m && m.host);
  if (machines.length > 1) {
    const ago = ts => {
      const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.round(mins / 60);
      if (hrs < 48) return hrs + 'h ago';
      return Math.round(hrs / 24) + 'd ago';
    };
    let combined = 0;
    const rate = (aic.config && aic.config.overageCostPerCredit) || 0.01;
    const usd = c => '$' + (c * rate).toFixed(2);
    const sysRows = machines.map(m => {
      const sameCycle = m.cycleStart === aic.billingCycleStart;
      if (sameCycle) combined += (m.cycleCredits || 0);
      const tag = m.isThisMachine
        ? ' <span style="color:#4ec9b0;font-size:10px">(this system)</span>'
        : '';
      const stale = m.dormant
        ? ' <span style="color:#e5c07b;font-size:10px" title="No update in over 7 days — its figures may be out of date">dormant</span>'
        : '';
      const cyc = sameCycle
        ? ''
        : ' <span style="color:#e5c07b;font-size:10px" title="Reported against a different billing cycle, so it is excluded from the combined total">other cycle</span>';
      return '<tr><td><strong>'+esc(m.label)+'</strong>'+tag+'</td>'
        + '<td>'+esc(m.host)+' <span style="color:var(--muted);font-size:10px">'+esc(m.platform)+'</span></td>'
        + '<td class="num">'+(+(m.cycleCredits||0)).toFixed(2)+cyc+'</td>'
        + '<td class="num" style="color:var(--muted)">'+usd(m.cycleCredits||0)+'</td>'
        + '<td class="num">'+(m.sessions||0)+'</td>'
        + '<td class="num">'+(m.turns||0)+'</td>'
        + '<td class="num">'+(m.totalTokens||0).toLocaleString()+'</td>'
        + '<td>'+ago(m.lastSeen)+stale+'</td></tr>';
    }).join('');

    // The budget is an account allowance, not a per-machine one, so overage is
    // only meaningful against the combined figure — the per-system dollar
    // amounts above are gross value at the same rate, not separate bills.
    const effBudget = isPromo ? promo.promoBudget : (aic.monthlyBudget || 0);
    const overCombined = effBudget > 0 ? Math.max(0, combined - effBudget) : 0;
    const overageRow = effBudget > 0
      ? '<tr><td colspan="3" style="text-align:right;color:var(--muted)">'
        + 'Combined overage vs '+effBudget.toLocaleString()+'-credit allowance'+(isPromo ? ' (promo)' : '')+':</td>'
        + '<td class="num"><strong style="color:'+(overCombined > 0 ? 'var(--orange)' : 'var(--green)')+'">'
        + '$'+(overCombined * rate).toFixed(2)+'</strong></td><td colspan="4"></td></tr>'
      : '';

    systemsHTML = '<div style="margin-top:16px">'
      + '<div class="section-title" style="margin-bottom:8px">Systems — Combined Usage</div>'
      + '<div style="padding:8px 10px;background:var(--border);border-radius:4px;font-size:10px;color:var(--muted);margin-bottom:8px">'
      + 'Each system publishes a rollup of its own credits over Settings Sync. Logs, prompts and session contents are never shared. '
      + 'The headline tiles above remain this-system-only, so they stay reconcilable against local data; the combined figure is shown here. '
      + 'Per-system cost is credits &times; $'+rate+' &mdash; gross value, not a separate bill. Only the combined overage below is chargeable.'
      + '</div>'
      + '<table><thead><tr><th>System</th><th>Host</th><th class="num">Credits (cycle)</th><th class="num">Cost</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Tokens</th><th>Last seen</th></tr></thead><tbody>'
      + sysRows
      + '</tbody><tfoot><tr><td colspan="2" style="text-align:right;color:var(--muted)">Combined this cycle:</td>'
      + '<td class="num"><strong>'+combined.toFixed(2)+'</strong></td>'
      + '<td class="num"><strong>'+usd(combined)+'</strong></td><td colspan="4"></td></tr>'
      + overageRow
      + '</tfoot></table>'
      + '</div>';
  }

  el.innerHTML = '<div class="table-card"><div class="section-head"><div class="section-title">AI Credits (AIC) — Usage-Based Billing'+promoTag+'</div><div class="section-subtitle">Cycle: '+esc(aic.billingCycleStart)+' to '+esc(aic.billingCycleEnd)+' • '+planLabel+' Plan</div></div>'
    + budgetBar
    + '<div class="stats-row">' + statsCards.map(c=>'<div class="stat-card"><div class="label">'+c.l+'</div><div class="value'+(c.c?' '+c.c:'')+'">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('') + '</div>'
    + overageHTML
    + cacheNote
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">'
    + '<div><div class="section-title" style="margin-bottom:8px">AI Credits by Model</div><table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">Total</th></tr></thead><tbody>'+modelRows+'</tbody></table></div>'
    + '<div>'+calendarHTML+'</div>'
    + '</div>'
    + nonBillableHTML
    + systemsHTML
    + '</div>';
}

function renderAgentSessions(agent, bounds, filteredSessions, rangeAicTotal) {
  const el = document.getElementById('agent-section');
  if (!agent) { el.innerHTML = ''; return; }

  // fmt helpers — inline since they're one-off and used only here
  const fmtAIC = v => (+v).toFixed(2);

  // Range-filtered VS Code values from sessions
  const vscodeSessions = filteredSessions.length;
  const vscodeTurns = filteredSessions.reduce((s,x) => s + x.turns, 0);
  const vscodeTotalTokens = filteredSessions.reduce((s,x) => s + (x.actualPrompt||x.prompt) + (x.actualOutput||x.output), 0);

  const cliDisplayCredits = (agent.cliTotalCredits && agent.cliTotalCredits > 0)
    ? agent.cliTotalCredits
    : (agent.cliLlmCalls && agent.cliLlmCalls > 0 ? agent.cliLlmCalls : 0);

  // VS Code AIC = authoritative range total minus source-attributed buckets.
  // Matches agentSummary.vscodeAicCredits (dashboardData.ts) and includes
  // live OTel overlay credits that aren't tied to any single chat session.
  // For non-cycle ranges we fall back to the session sum since agent totals
  // are cycle/all-time scoped (mixing them would over-subtract).
  const isCycleAlignedRange = selectedRange === 'tm' || selectedRange === 'all' || (!bounds.start && !bounds.end);
  const vscodeAicCredits = isCycleAlignedRange && typeof rangeAicTotal === 'number'
    ? Math.max(0, rangeAicTotal - (agent.ompTotalCredits||0) - (agent.piTotalCredits||0) - cliDisplayCredits)
    : filteredSessions.reduce((s,x) => s + (x.aicCredits||0), 0);
  const hasAgentData = agent.ompSessions > 0 || agent.piSessions > 0 || agent.cliSessions > 0;
  const agentNote = hasAgentData
    ? ''
    : '<div style="margin-top:6px;font-size:11px;color:var(--muted)">No OMP, Pi, or GitHub Copilot CLI sessions found for this billing period. ' +
      'Sessions will appear once activity is detected in ' +
      '<code>~/.omp/agent/sessions</code>, <code>~/.pi/agent/sessions</code>, or ' +
      '<code>~/.copilot/session-state</code>.</div>';

  // CLI drift / fallback diagnostic — shown only when CLI data exists.
  // The CLI hybrid scanner reports liveAic vs ledgerAic for sessions with
  // both signals (see src/cliScanner.ts). A non-zero drift is normal and
  // typically small (±5% on clean sessions per the diagnostic in
  // tests/diagnose-copilot-cli.mjs). Live-only sessions are sessions that
  // never emitted a session.shutdown event (crash, Ctrl-C, still-open).
  const cliDiagBits = [];
  if (agent.cliReconciledSessions > 0) {
    cliDiagBits.push(agent.cliReconciledSessions + ' ledger-reconciled');
  }
  if (agent.cliLiveOnlySessions > 0) {
    cliDiagBits.push(agent.cliLiveOnlySessions + ' live-only');
  }
  if (Math.abs(agent.cliDriftAic || 0) >= 0.01) {
    const sign = agent.cliDriftAic > 0 ? '+' : '';
    cliDiagBits.push('drift ' + sign + agent.cliDriftAic.toFixed(2) + ' AIC');
  }
  const cliDiagNote = (agent.cliSessions > 0 && cliDiagBits.length > 0)
    ? '<div style="margin-top:6px;font-size:11px;color:var(--muted)">CLI: ' + cliDiagBits.join(' · ') +
      ' · home <code>' + esc(agent.cliCopilotHome || '~/.copilot') + '</code></div>'
    : '';

  // Total row values — VS Code is range-filtered; OMP/Pi/CLI are all-time
  // because those scanners don't expose per-date granularity to the webview.
  // We DO NOT sum them into a single Total — mixing a filtered window with
  // all-time data would be misleading. Show em-dash placeholder for Total when
  // any range other than all-time (or cycle-aligned 'tm') is selected.
  const isAllTimeRange = !bounds.start && !bounds.end;
  const totalSess  = vscodeSessions + (agent.ompSessions||0) + (agent.piSessions||0) + (agent.cliSessions||0);
  const totalCalls = vscodeTurns + (agent.ompLlmCalls||0) + (agent.piLlmCalls||0) + (agent.cliLlmCalls||0);
  const totalTok   = vscodeTotalTokens + (agent.ompAllTimeTokens||0) + (agent.piAllTimeTokens||0) + (agent.cliAllTimeTokens||0);
  const totalAIC   = fmtAIC(vscodeAicCredits + (agent.ompTotalCredits||0) + (agent.piTotalCredits||0) + cliDisplayCredits);
  const totalCell = v => isCycleAlignedRange
    ? '<td class="num orange"><strong>'+v+'</strong></td>'
    : '<td class="num" style="color:var(--muted)" title="VS Code is range-filtered; OMP/Pi/CLI are all-time — a combined total would mix time windows">—</td>';

  const fmtTok = v => {
    if (v >= 1e9) return (v/1e9).toFixed(2)+'B';
    if (v >= 1e6) return (v/1e6).toFixed(1)+'M';
    if (v >= 1e3) return (v/1e3).toFixed(1)+'K';
    return String(v);
  };

  // Source badge styles matching the existing model-tag color scheme
  const srcBadge = (label, color) =>
    '<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;' +
    'background:'+color+';color:#fff;margin-right:4px">'+label+'</span>';

  const tbody =
    '<tr>' +
      '<td>Sessions</td>' +
      '<td class="num">'+vscodeSessions+'</td>' +
      '<td class="num">'+(agent.ompSessions||0)+'</td>' +
      '<td class="num">'+(agent.piSessions||0)+'</td>' +
      '<td class="num">'+(agent.cliSessions||0)+'</td>' +
      totalCell(totalSess) +
    '</tr>' +
    '<tr>' +
      '<td>Turns / LLM Calls / Prompts</td>' +
      '<td class="num">'+vscodeTurns.toLocaleString()+'</td>' +
      '<td class="num">'+(agent.ompLlmCalls||0).toLocaleString()+'</td>' +
      '<td class="num">'+(agent.piLlmCalls||0).toLocaleString()+'</td>' +
      '<td class="num" title="User prompts in the billing window (slash commands excluded)">'+(agent.cliLlmCalls||0).toLocaleString()+'</td>' +
      totalCell(totalCalls.toLocaleString()) +
    '</tr>' +
    '<tr>' +
      '<td>Tokens — prompt + output <span style="font-size:10px;color:var(--muted)">(VS Code: range filtered · OMP/Pi/CLI: all time)</span></td>' +
      '<td class="num" title="Tokens from range-filtered VS Code sessions">'+fmtTok(vscodeTotalTokens)+'</td>' +
      '<td class="num" title="All-time historical OMP agent tokens">'+fmtTok(agent.ompAllTimeTokens||0)+'</td>' +
      '<td class="num" title="All-time historical Pi agent tokens">'+fmtTok(agent.piAllTimeTokens||0)+'</td>' +
      '<td class="num" title="All-time CLI live output tokens (from assistant.message events)">'+fmtTok(agent.cliAllTimeTokens||0)+'</td>' +
      totalCell(fmtTok(totalTok)) +
    '</tr>' +
    '<tr style="border-top:1px solid var(--border)">' +
      '<td><strong>AIC Credits</strong> <span style="font-size:10px;color:var(--muted)">(Jun 1+ only)</span></td>' +
      '<td class="num orange">'+fmtAIC(vscodeAicCredits)+'</td>' +
      '<td class="num orange">'+fmtAIC(agent.ompTotalCredits||0)+'</td>' +
      '<td class="num orange">'+fmtAIC(agent.piTotalCredits||0)+'</td>' +
      '<td class="num orange" title="API-billed totalNanoAiu from session.shutdown when present, else prompts × multiplier while live">'+fmtAIC(cliDisplayCredits)+'</td>' +
      totalCell(totalAIC) +
    '</tr>';

  el.innerHTML = '<div class="table-card source-usage"><div class="section-head">'
    + '<div class="section-title">Usage by Source'
    +   ' ' + srcBadge('VS Code','#0078d4')
    +   ' ' + srcBadge('OMP','#7c3aed')
    +   ' ' + srcBadge('Pi','#059669')
    +   ' ' + srcBadge('CLI','#dc2626')
    + '</div>'
    + '<div class="section-subtitle">Per-source breakdown — all AIC credits feed into the shared billing budget above</div>'
    + '</div>'
    + '<table><thead><tr>'
    +   '<th>Metric</th>'
    +   '<th class="num" title="Range-filtered per current selection">VS Code <span style="font-size:9px;color:var(--muted);font-weight:400">(range)</span></th>'
    +   '<th class="num" title="All-time — OMP scanner does not expose per-date data to the webview">Oh My Pi <span style="font-size:9px;color:var(--muted);font-weight:400">(all time)</span></th>'
    +   '<th class="num" title="All-time — Pi scanner does not expose per-date data to the webview">Pi <span style="font-size:9px;color:var(--muted);font-weight:400">(all time)</span></th>'
    +   '<th class="num" title="All-time — CLI scanner does not expose per-date data to the webview">Copilot CLI <span style="font-size:9px;color:var(--muted);font-weight:400">(all time)</span></th>'
    +   '<th class="num">Total</th>'
    + '</tr></thead><tbody>'
    + tbody
    + '</tbody></table>'
    + agentNote
    + cliDiagNote
    + '</div>';
}

function dc(k) {
  if(charts[k]) {
    const canvas = charts[k].canvas;
    charts[k].destroy();
    if (canvas) {
      canvas.removeAttribute('width');
      canvas.removeAttribute('height');
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    }
    charts[k]=null;
  }
}

function sizeScrollableChart(frameId, height) {
  const frame = document.getElementById(frameId);
  if (!frame) return null;
  const canvas = frame.querySelector('canvas');
  if (!canvas) return null;
  const displayHeight = Math.max(300, Math.min(height, 900));
  frame.style.height = displayHeight+'px';
  return canvas;
}

function renderDaily(daily) {
  dc('daily');
  const days = [...new Set(daily.map(d=>d.day))].sort();
  const pMap={}, oMap={};
  days.forEach(d=>{pMap[d]=0;oMap[d]=0;});
  daily.forEach(d=>{pMap[d.day]+=d.prompt;oMap[d.day]+=d.output;});
  charts.daily = new Chart(document.getElementById('dailyChart'), {
    type:'bar', data:{labels:days, datasets:[
      {label:'Prompt',data:days.map(d=>pMap[d]),backgroundColor:tc('chart-bar1'),stack:'tokens',yAxisID:'y'},
      {label:'Output',data:days.map(d=>oMap[d]),backgroundColor:tc('chart-bar2'),stack:'tokens',yAxisID:'y'}
    ]},
    options:{responsive:true,maintainAspectRatio:false, plugins:{legend:{labels:{color:tc('muted')}}}, scales:{
      x:{stacked:true,ticks:{color:tc('muted'),maxRotation:45},grid:{color:tc('grid')}},
      y:{position:'left',stacked:true,ticks:{color:tc('blue'),callback:v=>fmt(v)},grid:{color:tc('grid')},title:{display:true,text:'Tokens',color:tc('blue')}}
    }}
  });
  // Insight caption
  const ins = document.getElementById('dailyInsight');
  if (ins) {
    if (!days.length) { ins.textContent = 'No data in the selected range.'; }
    else {
      const totals = days.map(d => ({day:d, total:(pMap[d]||0)+(oMap[d]||0)}));
      const peak = totals.reduce((a,b) => b.total>a.total?b:a, totals[0]);
      const sum = totals.reduce((s,x)=>s+x.total, 0);
      const avg = sum/days.length;
      const pctOfTotal = sum>0 ? Math.round((peak.total/sum)*100) : 0;
      ins.innerHTML = 'Peak day: <strong>'+peak.day+'</strong> with <strong>'+fmt(peak.total)+'</strong> tokens ('+pctOfTotal+'% of period). Daily average: <strong>'+fmt(Math.round(avg))+'</strong> tokens across <strong>'+days.length+'</strong> days.';
    }
  }
}

function renderModelPie(sessions) {
  dc('model');
  const m={};
  sessions.forEach(s=>{m[s.model]=(m[s.model]||0)+(s.actualPrompt||s.prompt)+(s.actualOutput||s.output);});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  charts.model = new Chart(document.getElementById('modelChart'), {
    type:'doughnut', data:{labels:sorted.map(e=>e[0]),datasets:[{data:sorted.map(e=>e[1]),backgroundColor:MODEL_COLORS.slice(0,sorted.length)}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:tc('muted')}}}}
  });
}

function renderProjectBar(sessions) {
  dc('project');
  const pm={},om={},cm={};
  sessions.forEach(s=>{
    pm[s.project]=(pm[s.project]||0)+(s.actualPrompt||s.prompt);
    om[s.project]=(om[s.project]||0)+(s.actualOutput||s.output);
    cm[s.project]=(cm[s.project]||0)+(s.aicCredits||0);
  });
  const rate = (DATA.aicSummary && DATA.aicSummary.config && DATA.aicSummary.config.overageCostPerCredit) || 0.01;
  const sorted=Object.entries(pm).map(([k,v])=>[k,v+(om[k]||0)]).sort((a,b)=>b[1]-a[1]);
  const labels=sorted.map(e=>e[0]);
  const pH=Math.max(300, sorted.length*28);
  const canvas = sizeScrollableChart('projectChartFrame', pH);
  if(!canvas) return;

  // Right-of-bar $ cost annotation. Closure captures cm/rate/labels.
  const costLabelPlugin = {
    id:'projCostLabels',
    afterDatasetsDraw(chart){
      const { ctx, chartArea, scales } = chart;
      if(!chartArea||!scales.y) return;
      const yScale = scales.y;
      ctx.save();
      ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif';
      ctx.fillStyle = tc('orange');
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      labels.forEach((lab,i)=>{
        const y = yScale.getPixelForValue(i);
        if(y==null||isNaN(y)) return;
        const c = cm[lab]||0;
        ctx.fillText('$'+(c*rate).toFixed(2), chartArea.right + 6, y);
      });
      ctx.restore();
    }
  };

  charts.project = new Chart(canvas, {
    type:'bar',
    data:{labels, datasets:[
      {label:'Prompt',data:labels.map(l=>pm[l]||0),backgroundColor:tc('chart-bar1')},
      {label:'Output',data:labels.map(l=>om[l]||0),backgroundColor:tc('chart-bar2')}
    ]},
    plugins:[costLabelPlugin],
    options:{
      indexAxis:'y',responsive:true,maintainAspectRatio:false,
      layout:{ padding:{ right: 82 } },
      plugins:{
        legend:{labels:{color:tc('muted')}},
        tooltip:{callbacks:{
          footer:(items)=>{
            if(!items||!items.length) return '';
            const proj=items[0].label; const c=cm[proj]||0;
            return 'Credits: '+c.toFixed(1)+'  ·  $'+(c*rate).toFixed(2);
          }
        }}
      },
      scales:{
        x:{stacked:true,ticks:{color:tc('muted'),callback:v=>fmt(v)},grid:{color:tc('grid')}},
        y:{stacked:true,ticks:{color:tc('muted'),font:{size:10}},grid:{color:tc('grid')}}
      }
    }
  });
  renderProjectCostInsight(cm, rate);
}

function renderProjectCostInsight(cm, rate) {
  const tabPanel = document.getElementById('bk-project');
  if(!tabPanel) return;
  let insight = tabPanel.querySelector('.project-cost-insight');
  if(!insight){
    insight = document.createElement('div');
    insight.className = 'insight project-cost-insight';
    tabPanel.appendChild(insight);
  }
  const entries = Object.entries(cm).filter(([,v])=>v>0);
  if(!entries.length){ insight.innerHTML = '<span style="color:var(--muted)">No AI credits recorded for these projects in the current range.</span>'; return; }
  const total = entries.reduce((s,[,v])=>s+v,0);
  const top = entries.sort((a,b)=>b[1]-a[1]).slice(0,3);
  const topHtml = top.map(([n,v])=>esc(n)+' <strong>$'+(v*rate).toFixed(2)+'</strong>').join('  ·  ');
  insight.innerHTML = '<strong>Total spent (this range):</strong> $'+(total*rate).toFixed(2)+' '
    + '<span style="color:var(--muted)">('+total.toFixed(1)+' credits @ $'+rate+'/credit)</span>'
    + '  —  <strong>Top by cost:</strong>  '+topHtml
    + '  <span style="color:var(--muted);font-size:10px">• hover any bar for its cost</span>';
}

function renderToolBar(tools) {
  dc('tool');
  const m={};
  tools.forEach(t=>{m[t.toolName]=(m[t.toolName]||0)+t.count;});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  const tH=Math.max(300, sorted.length*28);
  const canvas = sizeScrollableChart('toolChartFrame', tH);
  if(!canvas) return;
  charts.tool = new Chart(canvas, {
    type:'bar', data:{labels:sorted.map(e=>e[0]),datasets:[{label:'Calls',data:sorted.map(e=>e[1]),backgroundColor:tc('chart-bar1')}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{
      x:{ticks:{color:tc('muted')},grid:{color:tc('grid')}},
      y:{ticks:{color:tc('muted'),font:{size:10}},grid:{color:tc('grid')}}
    }}
  });
}

function renderSessions(sessions, subs) {
  const el = document.getElementById('sessions-section');
  if (!sessions.length) { el.innerHTML=''; return; }
  const rate = (DATA.aicSummary && DATA.aicSummary.config && DATA.aicSummary.config.overageCostPerCredit) || 0.01;
  const sm={};
  subs.forEach(s=>{if(!sm[s.sessionId])sm[s.sessionId]={};sm[s.sessionId][s.agentName]=(sm[s.sessionId][s.agentName]||0)+s.count;});
  const trunc=(str,n)=>{ if(!str) return ''; const t=String(str).replace(/\s+/g,' ').trim(); return t.length>n ? t.slice(0,n-1)+'\u2026' : t; };
  let rows='';
  sessions.forEach(s=>{
    const mult=getMult(s.modelName,s.multiplier);
    const sd=sm[s.sessionId]?Object.entries(sm[s.sessionId]).map(([a,c])=>'<span class="pill">'+esc(a)+' x'+c+'</span>').join(' '):'';
    const ap=s.agentId?'<span class="pill pill-green">'+esc(s.agentId)+'</span>':'';
    const bp=s.account?'<span class="pill pill-blue">'+esc(s.account)+'</span>':'';
    const titleFull=s.title||'';
    const previewFull=s.promptPreview||'';
    const titleShort=trunc(titleFull,60);
    const previewShort=trunc(previewFull,80);
    const sumTooltip=esc([titleFull,previewFull].filter(Boolean).join(' \u2014 '));
    const sum='<div class="summary-cell" title="'+sumTooltip+'">'+(titleShort?'<div class="title">'+esc(titleShort)+'</div>':'')+(previewShort?'<div class="preview">'+esc(previewShort)+'</div>':'')+'<div class="tags">'+ap+' '+bp+'</div></div>';
    const fl=(s.sourcePaths||[]).map((p,i)=>'<span class="file-link" data-path="'+esc(p)+'" title="'+esc(p)+'">log '+(i+1)+'</span>').join('')
      +(s.transcriptPaths||[]).map((p,i)=>'<span class="file-link" data-path="'+esc(p)+'" title="'+esc(p)+'">transcript '+(i+1)+'</span>').join('');
    const flDiv=fl?'<div class="file-links">'+fl+'</div>':'';
    // Cache % is pre-computed in dashboardData.ts (see cache.ts). Webview
    // never inlines the arithmetic — one source of truth for the formula.
    const cacheCell=s.actualPrompt>0?'<td class="num cached">'+(s.cacheHitPct||0).toFixed(1)+'%</td>':'<td class="num">—</td>';
    const costCell=s.aicCredits?'<td class="num orange">$'+(s.aicCredits*rate).toFixed(2)+'</td>':'<td class="num">—</td>';
    rows+='<tr><td style="font-family:monospace;font-size:11px">'+esc(s.sessionShort)+'...</td><td>'+esc(s.project)+'</td><td>'+sum+'</td><td style="font-size:11px">'+esc(s.last)+'</td><td class="num">'+s.durationMin+'m</td><td><span class="model-tag '+mc(s.modelName)+'">'+esc(s.modelName)+'</span>'+mbadge(mult)+'</td><td class="num">'+s.turns+'</td><td class="num">'+fmt(s.actualPrompt||s.prompt)+'</td><td class="num">'+fmt(s.actualOutput||s.output)+'</td>'+cacheCell+'<td class="num">'+fmt(s.toolCalls)+'</td><td class="num">'+(s.subagents||'')+(sd?' '+sd:'')+'</td><td class="num">'+(s.aicCredits?s.aicCredits.toFixed(1):'—')+'</td>'+costCell+'<td>'+flDiv+'</td></tr>';
  });
  el.innerHTML='<div class="table-card"><div class="section-title">All Sessions &mdash; '+sessions.length+' shown</div><div class="sessions-scroll table-scroll"><table><thead><tr><th>Session</th><th>Project</th><th>Summary</th><th>Last Active</th><th class="num">Duration</th><th>Model</th><th class="num">Turns</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Cache %</th><th class="num">Tools</th><th class="num">Subagents</th><th class="num">AI Credits</th><th class="num">Cost</th><th>Files</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  el.querySelectorAll('.file-link[data-path]').forEach(link => {
    link.addEventListener('click', () => { vscode.postMessage({type:'openFile',path:link.dataset.path}); });
  });
}

function renderModelTable(sessions) {
  const el=document.getElementById('model-section');
  const m={};
  sessions.forEach(s=>{
    const k=s.modelName;
    // Aggregate per session-primary-model. AI Credits are summed from each
    // session's aicCredits (which already includes all sub-model calls made
    // during that session — title-gen, subagents, model-change turns).
    // Previously this joined against aicSummary.byModel which keys on the
    // API-called model, not session-primary-model — that mismatch caused the
    // ~83-credit visible drift (opus-4.6 row showed 15,072 but the session
    // total was 15,155 because ~83 credits were from other models used
    // inside opus-4.6 sessions).
    if(!m[k]){m[k]={model:k,mult:getMult(k,s.multiplier),sessions:new Set(),turns:0,prompt:0,output:0,tools:0,subs:0,credits:0};}else{const sm=getMult(k,s.multiplier);if(sm>m[k].mult)m[k].mult=sm;}
    m[k].sessions.add(s.sessionId);
    m[k].turns+=s.turns;
    m[k].prompt+=(s.actualPrompt||s.prompt);
    m[k].output+=(s.actualOutput||s.output);
    m[k].tools+=s.toolCalls;
    m[k].subs+=s.subagents;
    m[k].credits+=(s.aicCredits||0);
  });
  const sorted=Object.values(m).sort((a,b)=>b.credits-a.credits || (b.prompt+b.output)-(a.prompt+a.output));
  let rows='';
  const totals = {sessions:new Set(), turns:0, prompt:0, output:0, tools:0, subs:0, credits:0};
  sorted.forEach(m=>{
    const credits = m.credits > 0 ? m.credits.toFixed(2) : '—';
    rows+='<tr><td><span class="model-tag '+mc(m.model)+'">'+esc(m.model)+'</span></td><td class="num">'+m.mult+'x</td><td class="num">'+m.sessions.size+'</td><td class="num">'+m.turns+'</td><td class="num">'+fmt(m.prompt)+'</td><td class="num">'+fmt(m.output)+'</td><td class="num">'+fmt(m.tools)+'</td><td class="num">'+m.subs+'</td><td class="num orange">'+credits+'</td></tr>';
    m.sessions.forEach(id=>totals.sessions.add(id));
    totals.turns+=m.turns; totals.prompt+=m.prompt; totals.output+=m.output;
    totals.tools+=m.tools; totals.subs+=m.subs; totals.credits+=m.credits;
  });
  // Authoritative TOTAL row — its Credits MUST equal the hero "AI Credits Spent"
  // (both are Σ session.aicCredits over the filtered range). If they diverge,
  // a bug has been introduced upstream.
  if (sorted.length > 0) {
    rows+='<tr style="border-top:2px solid var(--border);font-weight:600;background:rgba(255,255,255,0.02)"><td>TOTAL</td><td class="num">—</td><td class="num">'+totals.sessions.size+'</td><td class="num">'+totals.turns+'</td><td class="num">'+fmt(totals.prompt)+'</td><td class="num">'+fmt(totals.output)+'</td><td class="num">'+fmt(totals.tools)+'</td><td class="num">'+totals.subs+'</td><td class="num orange">'+totals.credits.toFixed(2)+'</td></tr>';
  }
  el.innerHTML='<div class="table-card"><div class="section-title">Usage by Model <span style="font-size:10px;color:var(--muted);font-weight:400;text-transform:none">(per session-primary-model \u2014 TOTAL row reconciles with hero)</span></div><table><thead><tr><th>Model</th><th class="num">Multiplier</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Prompt</th><th class="num">Output</th><th class="num">Tools</th><th class="num">Subagents</th><th class="num">AI Credits</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function renderSubagents(subs) {
  const el=document.getElementById('subagent-section');
  if(!subs.length){el.innerHTML='';return;}
  const m={};
  subs.forEach(s=>{m[s.agentName]=(m[s.agentName]||0)+s.count;});
  const sorted=Object.entries(m).sort((a,b)=>b[1]-a[1]);
  let rows='';
  sorted.forEach(([n,c])=>{rows+='<tr><td><span class="pill pill-orange">'+esc(n)+'</span></td><td class="num">'+c+'</td></tr>';});
  el.innerHTML='<div class="chart-card" style="height:100%"><h3>Subagent Usage</h3><table><thead><tr><th>Subagent</th><th class="num">Invocations</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}

function renderHourly(turns) {
  dc('hourly');
  if (!turns.length) {
    document.getElementById('hourlyTitle').textContent = 'Average Hourly Distribution';
    const ins0 = document.getElementById('hourlyInsight');
    if (ins0) ins0.textContent = 'No turn data in the selected range.';
    return;
  }
  // Compute hourly buckets
  const tzOff = selectedTz === 'local' ? new Date().getTimezoneOffset() : 0;
  const tzName = selectedTz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const hourTurns = new Array(24).fill(0);
  const hourOutput = new Array(24).fill(0);
  const daysSet = new Set();
  turns.forEach(t => {
    const d = new Date(t.timestamp);
    if (isNaN(d.getTime())) return;
    // Apply timezone
    const adjusted = new Date(d.getTime() - tzOff * 60000);
    const h = adjusted.getUTCHours();
    hourTurns[h]++;
    hourOutput[h] += t.output;
    daysSet.add(adjusted.toISOString().slice(0,10));
  });
  const numDays = Math.max(daysSet.size, 1);
  const avgTurns = hourTurns.map(v => Math.round(v / numDays * 10) / 10);
  const avgOutput = hourOutput.map(v => Math.round(v / numDays));

  // Peak hours: Mon-Fri 05:00-11:00 PT = 12:00-17:00 UTC
  const peakUtcStart = 12, peakUtcEnd = 17;
  function isPeakHour(h) {
    // Convert display hour back to UTC (tzOff is in minutes, positive=west)
    const utcH = selectedTz === 'local' ? (h + Math.floor(tzOff / 60) + 24) % 24 : h;
    return utcH >= peakUtcStart && utcH <= peakUtcEnd;
  }
  const barColors = avgTurns.map((_,h) => isPeakHour(h) ? tc('peak-bar') : tc('normal-bar'));

  const labels = Array.from({length:24}, (_,h) => {
    const lbl = String(h).padStart(2,'0')+':00';
    return isPeakHour(h) ? '\u26A1 '+lbl : lbl;
  });

  document.getElementById('hourlyTitle').textContent = 'Average Hourly Distribution — '+RANGE_LABELS[selectedRange]+' ('+numDays+' days) — '+tzName;
  // Update tz toggle state
  document.querySelectorAll('.tz-btn').forEach(b => b.classList.toggle('active', b.textContent.trim().toLowerCase() === selectedTz));

  charts.hourly = new Chart(document.getElementById('hourlyChart'), {
    type:'bar', data:{labels, datasets:[
      {label:'Avg Turns',data:avgTurns,backgroundColor:barColors,yAxisID:'y',order:2},
      {label:'Avg Output Tokens',data:avgOutput,type:'line',borderColor:tc('purple'),backgroundColor:tc('chart-bar2'),pointBackgroundColor:tc('purple'),pointRadius:3,yAxisID:'y1',tension:0.3,order:1}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{
      legend:{labels:{color:tc('muted')}},
      tooltip:{callbacks:{afterLabel:function(ctx){if(ctx.datasetIndex===0 && isPeakHour(ctx.dataIndex))return 'Peak — Anthropic US hours';return '';}}}
    },scales:{
      x:{ticks:{color:tc('muted'),maxRotation:45},grid:{color:tc('grid')}},
      y:{position:'left',ticks:{color:tc('orange')},grid:{color:tc('grid')},title:{display:true,text:'Avg Turns',color:tc('orange')}},
      y1:{position:'right',ticks:{color:tc('purple'),callback:v=>fmt(v)},grid:{drawOnChartArea:false},title:{display:true,text:'Avg Output Tokens',color:tc('purple')}}
    }}
  });
  // Insight caption — peak hour + concentration
  const ins = document.getElementById('hourlyInsight');
  if (ins) {
    let peakH = 0, peakV = 0, totalT = 0;
    avgTurns.forEach((v,h) => { totalT += v; if (v > peakV) { peakV = v; peakH = h; } });
    const peakLabel = String(peakH).padStart(2,'0')+':00';
    // Concentration: % of activity in 6h window around peak
    let windowSum = 0;
    for (let i = -3; i <= 3; i++) { windowSum += avgTurns[(peakH+i+24)%24]; }
    const concPct = totalT > 0 ? Math.round((windowSum/totalT)*100) : 0;
    ins.innerHTML = 'Peak activity at <strong>'+peakLabel+'</strong> ('+tzName+') averaging <strong>'+peakV+'</strong> turns/hour. <strong>'+concPct+'%</strong> of activity falls within ±3h of peak.';
  }
}

buildFilterBar();
queueRender();

// Wire up Breakdown tabs (once)
document.querySelectorAll('#breakdown-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#breakdown-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const targetId = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === targetId));
    // Resize charts when made visible (Chart.js needs a nudge)
    requestAnimationFrame(resizeCharts);
  });
});

window.addEventListener('resize', () => { requestAnimationFrame(resizeCharts); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (renderWhenVisible) {
    renderWhenVisible = false;
    queueRender();
  } else {
    requestAnimationFrame(resizeCharts);
  }
});

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'updateData' && msg.data) {
    DATA = msg.data;
    // Re-check model set: keep selected, add new models
    const newModels = new Set(DATA.allModels);
    selectedModels.forEach(m => { if (!newModels.has(m)) selectedModels.delete(m); });
    DATA.allModels.forEach(m => { if (!selectedModels.has(m)) selectedModels.add(m); });
    buildFilterBar();
    queueRender();
  }
});
<\/script>
</body>
</html>`;
  }
}
