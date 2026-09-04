/**
 * ttlState.ts — Pure prompt-cache TTL state machine. Zero `vscode` and zero
 * `fs` imports so it is trivially unit-testable.
 *
 * Derived from the MIT-licensed `cache-timer` extension
 * (https://github.com/sukumarp2022/cache-timer, © 2026 sukumarp2022) — the
 * `parse` state helpers, `format`, `urgency`, and `alert` modules are merged
 * here. See LICENSE for the full attribution notice.
 *
 * WHY A SEPARATE STATE MACHINE
 * ----------------------------
 * Providers keep a prompt cache alive for a short window after the last API
 * call (Anthropic documents ~5 min; OpenAI and Google are undocumented). Send
 * the next turn inside that window and the cached prefix is re-read at a
 * fraction of the input rate; miss it and the whole prefix is re-billed at the
 * full rate. `src/cache.ts` tells you how much reuse you GOT. This file tells
 * you how long you have LEFT to keep getting it.
 *
 * All thresholds are user-configurable and presented as approximate — none of
 * this is a documented billing guarantee.
 */

export type TtlState = "hot" | "green" | "yellow" | "red" | "cold";

export type TtlSource = "vscode" | "cli";

export interface TtlThresholds {
  /** Full assumed cache lifetime, in seconds. */
  timerValue: number;
  /** Seconds remaining at which the session turns yellow. */
  warnAt: number;
  /** Seconds remaining at which the session turns red (and may chime). */
  alertAt: number;
}

/** One tracked session, as rendered by the status bar / sidebar / dashboard. */
export interface SessionTtl {
  sessionId: string;
  title: string;
  source: TtlSource;
  /** Epoch ms of the newest LLM request in this session. */
  lastRequestMs: number;
  /** True while an agent turn is open — the cache is actively being refreshed. */
  working: boolean;
  model: string;
  provider: string;
  timerValue: number;
  warnAt: number;
  alertAt: number;
  /** Exact API-billed cost so far, in USD. Derived from `copilotUsageNanoAiu`. */
  costUsd: number;
  /** Cache-hit percentage for this session (cached / prompt * 100). */
  cacheHitPct: number;
  /** Seconds until the cache is assumed cold. Negative once expired. */
  remaining: number;
  state: TtlState;
}

// ─── State computation ────────────────────────────────────────

/** `remaining = timerValue - elapsedSeconds`. May go negative. */
export function computeRemaining(
  timerValue: number,
  nowMs: number,
  lastRequestMs: number
): number {
  return timerValue - (nowMs - lastRequestMs) / 1000;
}

export interface TurnMarks {
  lastTurnStartMs: number;
  lastTurnEndMs: number;
  lastRequestMs: number;
}

/**
 * A session is "working" (HOT) when a turn is open — the last `turn_start`
 * came after the last `turn_end`. When neither marker exists (CLI sessions,
 * or debug-logs from older Copilot builds) fall back to a short grace window
 * after the last request.
 */
export function computeWorking(
  marks: TurnMarks,
  nowMs: number,
  workingGraceSeconds: number
): boolean {
  const { lastTurnStartMs: start, lastTurnEndMs: end, lastRequestMs } = marks;
  if (start > 0 && start > end) {
    return true;
  }
  if (start === 0 && end === 0 && lastRequestMs > 0) {
    return nowMs - lastRequestMs <= workingGraceSeconds * 1000;
  }
  return false;
}

export function computeState(
  working: boolean,
  remaining: number,
  warnAt: number,
  alertAt: number
): TtlState {
  if (working) {
    return "hot";
  }
  if (remaining <= 0) {
    return "cold";
  }
  if (remaining <= alertAt) {
    return "red";
  }
  if (remaining <= warnAt) {
    return "yellow";
  }
  return "green";
}

/** Still worth showing: within `timerValue + grace` of the last request. */
export function isWithinActiveWindow(
  lastRequestMs: number,
  nowMs: number,
  timerValue: number,
  expiredGraceSeconds: number
): boolean {
  if (lastRequestMs <= 0) {
    return false;
  }
  return (nowMs - lastRequestMs) / 1000 <= timerValue + expiredGraceSeconds;
}

// ─── Ordering ─────────────────────────────────────────────────

/** Lower number = more urgent. Drives which session leads the status bar. */
export const URGENCY: Record<TtlState, number> = {
  red: 0,
  yellow: 1,
  green: 2,
  hot: 3,
  cold: 4,
};

export function urgencyCompare(
  a: Pick<SessionTtl, "state" | "remaining">,
  b: Pick<SessionTtl, "state" | "remaining">
): number {
  const ua = URGENCY[a.state] ?? URGENCY.green;
  const ub = URGENCY[b.state] ?? URGENCY.green;
  if (ua !== ub) {
    return ua - ub;
  }
  return a.remaining - b.remaining;
}

// ─── Formatting ───────────────────────────────────────────────

export function stateEmoji(state: TtlState): string {
  switch (state) {
    case "hot":
      return "\u{1F525}";
    case "green":
      return "\u{1F7E2}";
    case "yellow":
      return "\u{1F7E1}";
    case "red":
      return "\u{1F534}";
    case "cold":
      return "\u2744\uFE0F";
  }
}

/** Theme-color token for the state, used by the sidebar/dashboard webviews. */
export function stateColor(state: TtlState): string {
  switch (state) {
    case "hot":
      return "var(--vscode-charts-blue)";
    case "green":
      return "var(--vscode-charts-green)";
    case "yellow":
      return "var(--vscode-charts-yellow)";
    case "red":
      return "var(--vscode-charts-red)";
    case "cold":
      return "var(--vscode-descriptionForeground)";
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** `M:SS`, or `H:MM:SS` at or above one hour. Negative clamps to `0:00`. */
export function formatTtl(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours >= 1) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${minutes}:${pad2(seconds)}`;
}

/** `HOT` / `COLD` label, or the live countdown. */
export function stateDisplay(state: TtlState, remaining: number): string {
  if (state === "hot") {
    return "HOT";
  }
  if (state === "cold") {
    return "COLD";
  }
  return formatTtl(remaining);
}

/** Compact `<emoji> <display>` for the most urgent session, plus a count. */
export function aggregateText(sessions: SessionTtl[]): string {
  if (sessions.length === 0) {
    return "";
  }
  const top = sessions[0];
  const display = stateDisplay(top.state, top.remaining);
  const count = sessions.length > 1 ? ` (${sessions.length})` : "";
  return `${stateEmoji(top.state)} ${display}${count}`;
}

/** Truncate a session title for narrow surfaces. */
export function shortTitle(title: string, maxLen = 34): string {
  const t = (title || "").trim().replace(/\s+/g, " ");
  if (!t) {
    return "untitled";
  }
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}\u2026` : t;
}

// ─── Alert gating ─────────────────────────────────────────────

export interface AlertOptions {
  soundEnabled: boolean;
  notifyOnRed: boolean;
}

export interface AlertDecision {
  playSound: boolean;
  notify: boolean;
}

/**
 * Fire only on the transition INTO red, so a session sitting at red does not
 * re-alert on every one-second tick.
 */
export function alertDecision(
  prev: TtlState | undefined,
  next: TtlState,
  opts: AlertOptions
): AlertDecision {
  const enteredRed = next === "red" && prev !== "red";
  return {
    playSound: enteredRed && opts.soundEnabled,
    notify: enteredRed && opts.notifyOnRed,
  };
}
