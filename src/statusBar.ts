import * as vscode from "vscode";
import { LiveStats } from "./otelReceiver";
import { ScanStats } from "./scanner";
import { computeCacheHit, tierLabel } from "./cache";

/** Format a credit delta as a compact dollar/cent string for the flash badge. */
function fmtDelta(credits: number, dollarPerCredit: number): string {
  const cents = credits * dollarPerCredit * 100;
  if (cents >= 100) {
    return `+$${(cents / 100).toFixed(2)}`;
  }
  if (cents < 0.05) {
    return "+<1\u00a2";
  }
  // One decimal for sub-dollar so 8.4-credit requests still read as +8.4¢.
  return `+${cents.toFixed(1)}\u00a2`;
}

/** How long the per-request "+X\u00a2" badge stays visible after a new request. */
const FLASH_MS = 5000;

/** Current session info for the status bar (this VS Code instance only) */
export interface CurrentSessionInfo {
  sessionId: string;
  sessionShort: string;
  model: string;
  turns: number;
  prompt: number;
  output: number;
  toolCalls: number;
  durationMin: number;
  aicCredits: number;
}

export interface StatusBarData {
  otel: LiveStats | null;
  scan: ScanStats | null;
  /** Current/latest session for this instance */
  currentSession: CurrentSessionInfo | null;
  /** Total sessions in scan (for tooltip context) */
  totalSessions: number;
  /** Current session AIC credits (cumulative, billable scope) */
  currentSessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
  /**
   * Sum of `aicCredits` across live byModel rows classified as NON-billable
   * (Ollama / BYOK / unknown). Surfaced in the tooltip as
   * "$X.XX informational excluded" so users can SEE why the headline
   * session AIC is lower than the per-model table sum, instead of
   * silently dropping to 0. Optional for backward compatibility with the
   * legacy `update(stats)` entry point.
   */
  informationalAIC?: number;
  /** Daily-limit overlay state (optional — undefined = no limit feature active) */
  dailyLimit?: {
    stage: "none" | "warn" | "brace" | "limit";
    used: number;
    limit: number;
    percent: number;
    usedDollars: number;
    limitDollars: number;
    dollarMode: boolean;
    snoozed: boolean;
    resumed: boolean;
  };
  /** AIC → USD conversion rate (overageCostPerCredit, default 0.01). */
  dollarPerCredit?: number;
  /**
   * Optional per-period AIC + per-model token breakdown for the tooltip's
   * DAILY / WEEKLY / THIS MONTH donut row. `byModel.tokens` is used to
   * derive donut arc shares (token-share ≈ cost-share within a period).
   */
  ranges?: {
    daily: PeriodStats;
    weekly: PeriodStats;
    month: PeriodStats;
  };
  /**
   * Overall cache-hit rate across ALL sessions in the current billing cycle
   * (cached / prompt, where prompt already includes cached — see
   * aicCredits.ts:452). Rendered as the "Cache hit (cycle)" row in the
   * Snapshot table so users see the workspace-wide efficiency alongside
   * the live session-scoped number from the Cache reuse card.
   */
  cycleCacheHitPct?: number;
  /**
   * Session-scope prompt / cached counters sourced from `dashData.liveOtel`
   * — the SAME numbers the dashboard's "Live OpenTelemetry" section renders.
   * Threading them here guarantees the tooltip's "Cache hit (session)" row
   * and the dashboard's Cache Hit KPI can never diverge (before this we had
   * the tooltip reading `receiver.getStats()` directly, which excludes the
   * debug-log overlay when port 14318 is held by another window).
   */
  liveSessionPrompt?: number;
  liveSessionCached?: number;
}

export interface PeriodStats {
  aic: number;
  tokens: number;
  byModel: Array<{ model: string; tokens: number }>;
}

export class StatusBarProvider {
  private item: vscode.StatusBarItem;
  private walkTimer: ReturnType<typeof setInterval> | undefined;
  private walkFrame = 0;
  private walkStage: "none" | "warn" | "brace" = "none";
  private lastRenderedText = "";
  /** Most recent per-request AIC seen — used to detect "new request" transitions. */
  private lastSeenRequestAIC = 0;
  /** Wall-clock ms at which the +X\u00a2 flash badge should disappear. */
  private flashUntil = 0;
  /** One-shot timer that re-renders to clear the flash badge. */
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last data pushed in, cached so the flash timer can re-render without new input. */
  private lastData: StatusBarData | null = null;

  constructor(private commandId: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = commandId;
    this.updateStatus(null);
    this.item.show();
  }

  /** Legacy: OTel-only update */
  update(stats: LiveStats | null): void {
    this.updateStatus({
      otel: stats,
      scan: null,
      currentSession: null,
      totalSessions: 0,
      currentSessionAIC: 0,
      lastRequestAIC: 0,
      informationalAIC: 0,
    });
  }

  /**
   * Full update with current session + OTel data.
   *
   * Display contract (reimagined v2):
   *   - Idle              → `$(dashboard)`
   *   - Active calm       → `$(zap) $0.59`            (+ transient `+8.4\u00a2` flash for 5s)
   *   - Warn / Brace      → `<walker> $0.59 / $5.00`  (walker icon supplied by limitPrefix)
   *   - Limit hit         → `<stop> $5.00 LIMIT`
   *   - Limit + snoozed   → `<bell-slash> $5.00`
   *   - Limit + resumed   → `<continue> $5.04`
   *
   * All token counts, model name, session id, and workspace totals remain in
   * the tooltip — the bar surfaces only the cost number the user can act on.
   */
  updateStatus(data: StatusBarData | null): void {
    this.lastData = data;

    const otel = data?.otel;
    const hasOtel = otel && otel.requests > 0;
    const cs = data?.currentSession;
    const dl = data?.dailyLimit;
    const dpc = data?.dollarPerCredit ?? 0.01;

    // When at limit, the primary click action becomes "re-open Shield" so the
    // user never gets stuck with only the dashboard after dismissing the panel.
    if (dl && dl.stage === "limit") {
      this.item.command = "copilotUsage.dailyLimit.showShield";
    } else {
      this.item.command = this.commandId;
    }

    // Apply daily-limit coloring + prefix that always wins.
    this.applyLimitTheme(dl);
    const limitPrefix = this.limitPrefix(dl);

    // Any AIC seen for this window (OTel, cs, or the dashData overlay) means active.
    const sessionAIC = data?.currentSessionAIC ?? cs?.aicCredits ?? 0;
    if (!hasOtel && !cs && sessionAIC <= 0) {
      this.item.text = `${limitPrefix}$(dashboard)`;
      this.lastRenderedText = this.item.text;
      this.item.tooltip = this.buildTooltipForIdle(dl);
      return;
    }

    const sessionDollars = sessionAIC * dpc;
    const lastReqAIC = data?.lastRequestAIC ?? 0;

    // Detect a new request — trigger a 5-second flash badge.
    // Only on strict increase: avoids re-flashing after scan resets that
    // briefly drop the value to 0, and avoids attributing a prior window's
    // historical AIC to a "new" event on the first push.
    if (lastReqAIC > this.lastSeenRequestAIC) {
      this.flashUntil = Date.now() + FLASH_MS;
      this.scheduleFlashClear();
    }
    this.lastSeenRequestAIC = lastReqAIC;
    const showFlash = lastReqAIC > 0 && Date.now() < this.flashUntil;
    const delta = showFlash ? ` ${fmtDelta(lastReqAIC, dpc)}` : "";

    // Compose the body — dollars only, branched on daily-limit stage.
    // SCOPE NOTE: in warn/brace we display `dl.usedDollars / dl.limitDollars`
    // — BOTH day-scoped — so the fraction matches the background color (which
    // is driven by day percent). Mixing sessionDollars (this-window) with
    // dl.limitDollars (day) would put numerator and denominator on different
    // axes and confuse the user.
    let body: string;
    if (dl && dl.stage === "limit") {
      if (dl.resumed || dl.snoozed) {
        body = `$${dl.usedDollars.toFixed(2)}`;
      } else {
        body = `$${dl.usedDollars.toFixed(2)} LIMIT`;
      }
    } else if (dl && (dl.stage === "warn" || dl.stage === "brace")) {
      body = `$${dl.usedDollars.toFixed(2)} / $${dl.limitDollars.toFixed(2)}`;
    } else {
      // Calm active state — session dollars only (no day cap to show).
      // Prepend $(zap) since limitPrefix is empty here.
      body = `$(zap) $${sessionDollars.toFixed(2)}${delta}`;
    }

    this.item.text = `${limitPrefix}${body}`;
    this.lastRenderedText = this.item.text;
    this.item.tooltip = this.buildTooltipActive(data, otel, cs, dl);
  }

  /**
   * Tooltip for active states — rich MarkdownString hover modeled on
   * dashboard-style cost cards. Uses Unicode-block progress bars, colored
   * spans, codicons, and a compact stats grid. Every datum that used to be
   * emitted in the plain-text v1 tooltip is preserved.
   */
  private buildTooltipActive(
    data: StatusBarData | null,
    otel: LiveStats | null | undefined,
    cs: CurrentSessionInfo | null | undefined,
    dl: StatusBarData["dailyLimit"]
  ): vscode.MarkdownString {
    const dpc = data?.dollarPerCredit ?? 0.01;
    const sessAic = data?.currentSessionAIC ?? cs?.aicCredits ?? 0;
    const sessDollars = sessAic * dpc;
    const lastReq = data?.lastRequestAIC ?? 0;
    const infoAic = data?.informationalAIC ?? 0;

    const md: string[] = [];

    // ── Headline: big cost + stage badge ──────────────────────
    // Scope disambiguation: the $ next to the header is SESSION-scope
    // (this VS Code window only); the DAILY/WEEKLY/THIS MONTH donuts below
    // are workspace-wide period totals. Explicit "· Session" label prevents
    // users conflating the two scopes.
    const stageBadge = stageBadgeMd(dl);
    md.push(
      `### $(dashboard) Copilot Usage &nbsp;<span style="color:${COL.muted}">· Session</span>&nbsp; <span style="color:${COL.accent}">**$${sessDollars.toFixed(2)}**</span>${stageBadge}`
    );
    const sub: string[] = [`${sessAic.toFixed(2)} credits this session`];
    if (lastReq > 0) {
      sub.push(`last +${fmtDelta(lastReq, dpc).replace(/^\+/, "")}`);
    }
    if (infoAic > 0) {
      sub.push(`<span style="color:${COL.muted}">$${(infoAic * dpc).toFixed(2)} excluded</span>`);
    }
    md.push(sub.join(" &nbsp;·&nbsp; "));
    md.push("");

    // ── Card 1: DAILY / WEEKLY / THIS MONTH donut row (per-model shares) ──
    // Legend lists ONLY currently-active models (this OTel session, else the
    // debug-log's current session model). Historical-only models still show
    // as slices in the donuts but fold into a neutral "other" grey — so the
    // legend never grows to include stale versions like `claude-opus-4.6`
    // when the user is on `claude-opus-4.7` today.
    if (data?.ranges) {
      const legend = buildActiveModelLegend(otel, cs, data.ranges.daily);
      md.push(
        `| DAILY | WEEKLY | THIS MONTH |`,
        `|:-:|:-:|:-:|`,
        `| ${periodDonutMd(data.ranges.daily, legend, dpc)} | ${periodDonutMd(data.ranges.weekly, legend, dpc)} | ${periodDonutMd(data.ranges.month, legend, dpc)} |`,
      );
      if (legend.length > 0) {
        // One model per line (<br>-separated) so a growing legend from
        // concurrent sessions stacks vertically instead of wrapping into a
        // hard-to-scan run-on row.
        const legendLines = legend
          .map((l) => `<span style="color:${l.color}">●</span> ${escapeMd(l.model)}`)
          .join("<br>");
        md.push("");
        md.push(
          `<span style="color:${COL.muted}">${legendLines}<br><span style="color:${COL.accent2}">●</span> other</span>`
        );
      }
      md.push("");
      md.push("---");
      md.push("");
    }

    // ── Card 2: Daily limit progress bar ──
    if (dl && dl.stage !== "none") {
      const pctUsed = Math.min(100, Math.max(0, dl.percent));
      const pctLeft = Math.max(0, 100 - pctUsed);
      const barColor =
        dl.stage === "limit" ? COL.danger : dl.stage === "brace" ? COL.warn : COL.accent;
      const resetsIn = formatDuration(msUntilLocalMidnight());
      const right =
        dl.stage === "limit"
          ? `<span style="color:${COL.danger}">$(stop-circle) At limit &nbsp;·&nbsp; resets in ${resetsIn}</span>`
          : `<span style="color:${COL.muted}">$(clock) ${pctLeft.toFixed(0)}% left &nbsp;·&nbsp; resets in ${resetsIn}</span>`;
      md.push(`**$(shield) Daily limit** &nbsp;&nbsp; ${right}`);
      md.push("");
      md.push(progressBarMd(pctUsed, barColor));
      md.push("");
      md.push(
        `<span style="color:${COL.muted}">$${dl.usedDollars.toFixed(2)} of $${dl.limitDollars.toFixed(2)} &nbsp;·&nbsp; ${pctUsed.toFixed(0)}% used</span>`
      );
      md.push("");
    }

    // ── Card 3: Requests (compact — one header line + bar + terse footer) ──
    const reqStats = otel && otel.requests > 0
      ? {
          requests: otel.requests,
          prompt: otel.prompt,
          completion: otel.completion,
          source: "live",
        }
      : cs
        ? { requests: cs.turns, prompt: cs.prompt, completion: cs.output, source: "log" }
        : null;
    if (reqStats && reqStats.requests > 0) {
      const totalTokens = reqStats.prompt + reqStats.completion;
      // Soft benchmark: 20 requests per window — relative indicator, not a cap.
      const reqPct = Math.min(100, (reqStats.requests / 20) * 100);
      const srcTag =
        reqStats.source === "log"
          ? ` <span style="color:${COL.muted}">$(database) log</span>`
          : "";
      md.push(
        `**$(zap) Requests** &nbsp; <span style="color:${COL.muted}">${reqStats.requests} · ${fmtTokens(totalTokens)} tok${srcTag}</span>`
      );
      md.push("");
      md.push(progressBarMd(reqPct, COL.accent2));
      md.push("");
      md.push(
        `<span style="color:${COL.muted}">in ${fmtTokens(reqStats.prompt)} &nbsp;·&nbsp; out ${fmtTokens(reqStats.completion)}</span>`
      );
      md.push("");
      md.push("---");
      md.push("");
    }

    // ── Card 4: Cache hit ratio (Fable / blue-accent analogue) ──
    // Formula + tier thresholds live in cache.ts — the single source of truth
    // that prevents surface-to-surface drift (see cache.ts header). Computed
    // once and reused in the Snapshot row below to avoid duplicate work.
    const cacheP = (data?.liveSessionPrompt ?? otel?.prompt) ?? 0;
    const cacheC = (data?.liveSessionCached ?? otel?.cached) ?? 0;
    const sessionHit = computeCacheHit(cacheP, cacheC);
    if (sessionHit.tier !== "empty") {
      const label =
        sessionHit.tier === "excellent"
          ? `<span style="color:${COL.info}">$(sparkle) ${tierLabel(sessionHit.tier)}</span>`
          : `<span style="color:${COL.muted}">$(archive) ${tierLabel(sessionHit.tier)}</span>`;
      md.push(`**$(archive) Cache reuse** &nbsp;&nbsp; ${label}`);
      md.push("");
      md.push(progressBarMd(sessionHit.pct, COL.info));
      md.push("");
      md.push(
        `<span style="color:${COL.muted}">${sessionHit.cached.toLocaleString()} cached &nbsp;·&nbsp; ${sessionHit.pct.toFixed(0)}% of input</span>`
      );
      md.push("");
    }

    // Single-pair native markdown table. Right-alignment via `--:`;
    // the surrounding SVG progress bars already stretch the hover to their
    // width, so the value column sits flush with the tooltip's right edge.
    md.push(`**$(watch) Snapshot**`);
    md.push(`| &nbsp; | &nbsp; |`);
    md.push(`|:--|--:|`);
    md.push(`| Session AIC | ${sessAic.toFixed(2)} &nbsp;·&nbsp; $${sessDollars.toFixed(2)} |`);
    md.push(`| Last request | +${lastReq.toFixed(2)} credits |`);
    if (infoAic > 0) {
      md.push(`| Excluded (BYOK) | $${(infoAic * dpc).toFixed(2)} |`);
    }
    if (sessionHit.tier !== "empty") {
      md.push(`| Cache hit (session) | **${sessionHit.pct.toFixed(1)}%** |`);
    }
    if (data?.cycleCacheHitPct !== undefined) {
      md.push(`| Cache hit (cycle) | **${data.cycleCacheHitPct.toFixed(1)}%** |`);
    }
    if (cs) {
      md.push(`| Model | ${escapeMd(cs.model)} |`);
      md.push(`| Turns · Duration | ${cs.turns} · ${cs.durationMin}m |`);
      md.push(`| Tool calls | ${cs.toolCalls.toLocaleString()} |`);
      md.push(`| Session | \`${escapeMd(cs.sessionShort)}…\` |`);
    }
    if (data?.totalSessions) {
      md.push(`| Sessions in workspace | ${data.totalSessions.toLocaleString()} |`);
    }
    md.push("");

    md.push(`<span style="color:${COL.muted}">Cards = billing cycle totals</span>`);
    md.push("");
    md.push(
      dl && dl.stage === "limit"
        ? `$(link-external) **Click** to re-open the Daily Limit Shield`
        : `$(link-external) **Click** to open the full dashboard`
    );

    const tip = new vscode.MarkdownString(md.join("\n"));
    tip.supportThemeIcons = true;
    tip.supportHtml = true;
    tip.isTrusted = true;
    return tip;
  }

  /** Schedule a one-shot re-render at flashUntil to drop the +X\u00a2 badge. */
  private scheduleFlashClear(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    const delay = Math.max(50, this.flashUntil - Date.now() + 20);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      // Re-render with cached data — flash window has elapsed, badge will drop.
      this.updateStatus(this.lastData);
    }, delay);
  }

  dispose(): void {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = undefined;
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.item.dispose();
  }

  // ─── Daily-limit theming helpers ────────────────────────────

  private applyLimitTheme(dl: StatusBarData["dailyLimit"]): void {
    if (!dl) {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
      return;
    }
    if (dl.stage === "limit" && !dl.resumed) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.color = undefined;
    } else if (dl.stage === "brace" || dl.stage === "warn") {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.color = undefined;
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
  }

  private limitPrefix(dl: StatusBarData["dailyLimit"]): string {
    if (!dl) {
      this.stopWalker();
      return "";
    }
    if (dl.stage === "limit") {
      this.stopWalker();
      return dl.resumed
        ? "$(debug-continue) "
        : dl.snoozed
          ? "$(bell-slash) "
          : "$(stop-circle) $(hand) ";
    }
    if (dl.stage === "brace") {
      this.startWalker("brace");
      return this.walkerIcon("brace") + " ";
    }
    if (dl.stage === "warn") {
      this.startWalker("warn");
      return this.walkerIcon("warn") + " ";
    }
    this.stopWalker();
    return "";
  }

  /** Cycle a "walking" codicon by re-rendering the status bar every 450ms. */
  private startWalker(stage: "warn" | "brace"): void {
    if (this.walkStage === stage && this.walkTimer) {
      return;
    }
    this.walkStage = stage;
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
    }
    this.walkTimer = setInterval(() => {
      this.walkFrame = (this.walkFrame + 1) % 4;
      // Re-stamp the text with the new walker frame.
      const stamped = this.lastRenderedText.replace(
        /\$\((person|person-running|run|run-above|flame|warning)\)/,
        this.walkerIcon(this.walkStage)
      );
      if (stamped !== this.item.text) {
        this.item.text = stamped;
      }
    }, 450);
  }

  private stopWalker(): void {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = undefined;
    }
    this.walkStage = "none";
  }

  private walkerIcon(stage: "warn" | "brace" | "none"): string {
    if (stage === "none") {
      return "";
    }
    // 4-frame cycle that simulates a little walking character.
    const warnFrames = ["$(person)", "$(person-running)", "$(person)", "$(person-running)"];
    const braceFrames = ["$(flame)", "$(person-running)", "$(warning)", "$(person-running)"];
    const f = stage === "brace" ? braceFrames : warnFrames;
    return f[this.walkFrame % f.length];
  }

  private buildTooltipForIdle(dl: StatusBarData["dailyLimit"]): vscode.MarkdownString {
    const md: string[] = [];
    md.push(`### $(dashboard) Copilot Usage`);
    md.push(`<span style="color:${COL.muted}">No activity yet in this window.</span>`);
    md.push("");
    if (dl && dl.stage !== "none") {
      const pctUsed = Math.min(100, Math.max(0, dl.percent));
      const barColor =
        dl.stage === "limit" ? COL.danger : dl.stage === "brace" ? COL.warn : COL.accent;
      md.push(`**$(shield) Daily limit** ${stageBadgeMd(dl)}`);
      md.push(progressBarMd(pctUsed, barColor));
      md.push(
        `<span style="color:${COL.muted}">$${dl.usedDollars.toFixed(2)} of $${dl.limitDollars.toFixed(2)} &nbsp;·&nbsp; ${pctUsed.toFixed(0)}% used</span>`
      );
      md.push("");
    }
    md.push(
      dl && dl.stage === "limit"
        ? `$(link-external) **Click** to re-open the Daily Limit Shield`
        : `$(link-external) **Click** to open the full dashboard`
    );
    const tip = new vscode.MarkdownString(md.join("\n"));
    tip.supportThemeIcons = true;
    tip.supportHtml = true;
    tip.isTrusted = true;
    return tip;
  }
}

// ─── Rich-tooltip helpers ─────────────────────────────────────

/** Palette tuned to read on both light and dark VS Code themes. */
const COL = {
  accent: "#e06c4a", // orange — headline & session bar (matches Claude card)
  accent2: "#8a9aa6", // slate — secondary progress
  info: "#3b82f6", // blue — cache / positive signal (Fable bar)
  danger: "#e53935",
  warn: "#f0a020",
  muted: "#888888",
  track: "#3a3a3a",
} as const;

/** Discrete colors used for the per-model breakdown (donut slices). */
const MODEL_PALETTE = ["#e06c4a", "#2ea88a", "#8a4bd8", "#4a90e2", "#f0a020", "#d94a4a"];

/** Escape markdown-sensitive chars in user-supplied strings (model names, ids). */
function escapeMd(s: string): string {
  return s.replace(/[|`*_<>]/g, (c) => `\\${c}`);
}

/** Render a smooth pill-shaped progress bar as an SVG data URI. */
function progressBarMd(pct: number, color: string): string {
  // Narrower bar keeps the hover width close to the Snapshot table's natural
  // width so the right-aligned value column reads flush with the tooltip edge.
  const w = 220;
  const h = 10;
  const clamped = Math.max(0, Math.min(100, pct));
  const filledW = (clamped / 100) * w;
  const r = h / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${COL.track}"/>` +
    (filledW > 0
      ? `<rect x="0" y="0" width="${filledW.toFixed(2)}" height="${h}" rx="${r}" ry="${r}" fill="${color}"/>`
      : "") +
    `</svg>`;
  return `![](${svgDataUri(svg)})`;
}

/** Encode an inline SVG as a data URI safe for MarkdownString images. */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Render a donut/ring chart of model shares (visual match for the reference cost card). */
function donutMd(rows: Array<{ pct: number; color: string }>, size = 96): string {
  if (rows.length === 0) {
    return "";
  }
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const strokeW = size * 0.18;
  const C = 2 * Math.PI * r;
  const parts: string[] = [];
  // Track ring behind the slices.
  parts.push(
    `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="${COL.track}" stroke-width="${strokeW.toFixed(2)}"/>`
  );
  let offset = 0;
  for (const s of rows) {
    if (s.pct <= 0) {
      continue;
    }
    const arc = (s.pct / 100) * C;
    const gap = C - arc;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="${s.color}" ` +
        `stroke-width="${strokeW.toFixed(2)}" stroke-linecap="butt" ` +
        `stroke-dasharray="${arc.toFixed(2)} ${gap.toFixed(2)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(2)}" ` +
        `transform="rotate(-90 ${cx} ${cy})"/>`
    );
    offset += arc;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    parts.join("") +
    `</svg>`;
  return `![](${svgDataUri(svg)})`;
}

/** Milliseconds until local midnight — for "resets in X" captions. */
function msUntilLocalMidnight(): number {
  const now = new Date();
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return mid.getTime() - now.getTime();
}

/** Short human duration: "3h 42m" or "1d 4h" or "12m". */
function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) {
    return `${d}d ${h}h`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
}

/** Format a token count as compact "1.2M" / "3.4K". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

/**
 * Legend of *currently-active* models — the ones actually in use in this
 * VS Code window (OTel byModel preferred, debug-log `cs.model` fallback).
 * Historical models present in the 30-day range but NOT active right now
 * are intentionally excluded so the row doesn't list stale versions
 * (e.g. `claude-opus-4.6` when the session is on `claude-opus-4.7`).
 * Anything not in this legend renders as the neutral "other" grey slice
 * inside the donuts.
 */
function buildActiveModelLegend(
  otel: LiveStats | null | undefined,
  cs: CurrentSessionInfo | null | undefined,
  rangeFallback?: PeriodStats
): Array<{ model: string; color: string }> {
  const active = new Map<string, number>();
  if (otel && otel.byModel.size > 0) {
    for (const m of otel.byModel.values()) {
      const tokens = m.prompt + m.completion;
      if (tokens > 0) {
        active.set(m.model, tokens);
      }
    }
  }
  // OTel-silent fallback: pick up the model the debug-log currently attributes
  // this window to, so idle-OTel sessions still get a legend entry.
  if (active.size === 0 && cs && cs.model) {
    active.set(cs.model, cs.prompt + cs.output);
  }
  // Last-ditch fallback: seed from the DAILY period byModel so the donuts
  // still render colored slices when OTel is silent AND cs has not built yet.
  // Only the TOP model wins — the rest fold into "other" so the legend
  // stays a single "currently active" name, not a historical list.
  if (active.size === 0 && rangeFallback) {
    const top = rangeFallback.byModel.find((m) => m.tokens > 0);
    if (top) {
      active.set(top.model, top.tokens);
    }
  }
  const sorted = [...active.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  return sorted.map(([model], i) => ({ model, color: MODEL_PALETTE[i % MODEL_PALETTE.length] }));
}

/**
 * Render one period as a small donut (per-model shares from `byModel`) with
 * dollar amount and token count underneath. Slice colors are pulled from the
 * shared legend so DAILY / WEEKLY / MONTH stay visually aligned.
 */
function periodDonutMd(
  p: PeriodStats,
  legend: Array<{ model: string; color: string }>,
  dpc: number
): string {
  const usd = (p.aic * dpc).toFixed(2);
  const tk = fmtTokens(p.tokens);
  const otherColor = COL.accent2;
  const rows: Array<{ pct: number; color: string }> = [];
  const totalTokens = p.byModel.reduce((s, m) => s + m.tokens, 0);
  if (totalTokens > 0) {
    let coveredPct = 0;
    for (const legEntry of legend) {
      const found = p.byModel.find((m) => m.model === legEntry.model);
      if (found) {
        const pct = (found.tokens / totalTokens) * 100;
        rows.push({ pct, color: legEntry.color });
        coveredPct += pct;
      }
    }
    const otherPct = Math.max(0, 100 - coveredPct);
    if (otherPct > 0.1) {
      rows.push({ pct: otherPct, color: otherColor });
    }
  }
  // Empty-period fallback: render an empty ring so the layout stays consistent.
  const donut = rows.length > 0 ? donutMd(rows, 76) : donutMd([{ pct: 100, color: COL.track }], 76);
  return `${donut}<br>**$${usd}**<br><span style="color:${COL.muted}">${tk} tok</span>`;
}

/** Stage badge shown next to the headline (warn/brace/limit). */
function stageBadgeMd(dl: StatusBarData["dailyLimit"]): string {
  if (!dl || dl.stage === "none") {
    return "";
  }
  if (dl.stage === "limit") {
    const label = dl.resumed ? "resumed" : dl.snoozed ? "snoozed" : "at limit";
    return ` &nbsp;<span style="color:${COL.danger}">$(stop-circle) ${label}</span>`;
  }
  if (dl.stage === "brace") {
    return ` &nbsp;<span style="color:${COL.warn}">$(flame) brace</span>`;
  }
  return ` &nbsp;<span style="color:${COL.warn}">$(warning) warn</span>`;
}

