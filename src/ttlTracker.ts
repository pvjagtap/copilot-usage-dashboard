/**
 * ttlTracker.ts — Prompt-cache TTL tracker.
 *
 * This is the glue between the existing scan pipeline and the pure state
 * machine in `ttlState.ts`. It performs **no file I/O of its own**:
 *
 *   • `ingest()` is called from `runScan()` with the ScanResult that was
 *     already produced for the dashboard. The recursive `fs.watch` in
 *     extension.ts fires within ~10 ms of any `main.jsonl` write, so the
 *     countdown anchor is fresh without any polling loop of its own.
 *   • `tick()` runs once per second and is pure arithmetic over cached
 *     epoch-ms values — it never touches the disk, and it only runs while a
 *     UI surface is actually visible.
 *
 * The countdown itself is derived from the MIT-licensed `cache-timer`
 * extension (© 2026 sukumarp2022); its own detector/poll layer is deliberately
 * NOT ported because `src/scanner.ts` already produces strictly better data
 * (async, mtime-cached, and carrying exact `copilotUsageNanoAiu` billing).
 */

import * as vscode from "vscode";
import { ScanResult, Session } from "./scanner";
import { CliScanResult } from "./cliScanner";
import { computeCacheHit } from "./cache";
import { getTtlThresholds, mapTtlProvider, maxTimerValue } from "./ttlProviders";
import {
  SessionTtl,
  TtlState,
  TtlThresholds,
  alertDecision,
  computeRemaining,
  computeState,
  computeWorking,
  formatTtl,
  isWithinActiveWindow,
  shortTitle,
  urgencyCompare,
} from "./ttlState";
import { AlertQueue, createAlertQueue, resolveSoundPath } from "./ttlSound";

export interface TtlConfig {
  enabled: boolean;
  ttlMap: Record<string, Partial<TtlThresholds>>;
  soundEnabled: boolean;
  soundPath: string;
  alertRepeat: number;
  notifyOnRed: boolean;
  workingGraceSeconds: number;
  expiredGraceSeconds: number;
  maxSessions: number;
  showInStatusBar: boolean;
}

export const DEFAULT_TTL_CONFIG: TtlConfig = {
  enabled: false,
  ttlMap: {},
  soundEnabled: false,
  soundPath: "",
  alertRepeat: 1,
  notifyOnRed: false,
  workingGraceSeconds: 5,
  expiredGraceSeconds: 30,
  maxSessions: 20,
  showInStatusBar: true,
};

export function getTtlConfig(): TtlConfig {
  const cfg = vscode.workspace.getConfiguration("copilotUsage.cacheTtl");
  return {
    enabled: cfg.get<boolean>("enabled") ?? DEFAULT_TTL_CONFIG.enabled,
    ttlMap: cfg.get<Record<string, Partial<TtlThresholds>>>("ttl") ?? DEFAULT_TTL_CONFIG.ttlMap,
    soundEnabled: cfg.get<boolean>("soundEnabled") ?? DEFAULT_TTL_CONFIG.soundEnabled,
    soundPath: cfg.get<string>("soundPath") ?? DEFAULT_TTL_CONFIG.soundPath,
    alertRepeat: cfg.get<number>("alertRepeat") ?? DEFAULT_TTL_CONFIG.alertRepeat,
    notifyOnRed: cfg.get<boolean>("notifyOnRed") ?? DEFAULT_TTL_CONFIG.notifyOnRed,
    workingGraceSeconds:
      cfg.get<number>("workingGraceSeconds") ?? DEFAULT_TTL_CONFIG.workingGraceSeconds,
    expiredGraceSeconds:
      cfg.get<number>("expiredGraceSeconds") ?? DEFAULT_TTL_CONFIG.expiredGraceSeconds,
    maxSessions: cfg.get<number>("maxSessions") ?? DEFAULT_TTL_CONFIG.maxSessions,
    showInStatusBar: cfg.get<boolean>("showInStatusBar") ?? DEFAULT_TTL_CONFIG.showInStatusBar,
  };
}

/** Immutable inputs for one tracked session, refreshed by `ingest()`. */
interface TrackedSession {
  sessionId: string;
  title: string;
  source: "vscode" | "cli";
  lastRequestMs: number;
  lastTurnStartMs: number;
  lastTurnEndMs: number;
  model: string;
  provider: string;
  costUsd: number;
  cacheHitPct: number;
}

/** Hard cap so a pathological workspaceStorage cannot cause unbounded work. */
const MAX_TRACKED = 200;

export class TtlTracker implements vscode.Disposable {
  private tracked: TrackedSession[] = [];
  private rendered: SessionTtl[] = [];
  private tickHandle: ReturnType<typeof setInterval> | undefined;
  private readonly prevState = new Map<string, TtlState>();
  private readonly lastRequestSeen = new Map<string, number>();
  private readonly queue: AlertQueue = createAlertQueue();
  private readonly emitter = new vscode.EventEmitter<SessionTtl[]>();
  private uiVisible = true;
  private config: TtlConfig = DEFAULT_TTL_CONFIG;

  /** Fires whenever the rendered session list changes. */
  public readonly onChange = this.emitter.event;

  constructor(
    private readonly bundledSoundPath: string,
    private readonly dollarPerCredit: () => number
  ) {
    this.config = getTtlConfig();
  }

  public getSessions(): SessionTtl[] {
    return this.rendered;
  }

  /** The most urgent session, or null when nothing is tracked. */
  public getLead(): SessionTtl | null {
    return this.rendered.length > 0 ? this.rendered[0] : null;
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Pause the one-second tick while every TTL surface is hidden. The countdown
   * has no meaning nobody can see, and this keeps an idle window at zero cost.
   */
  public setUiVisible(visible: boolean): void {
    if (this.uiVisible === visible) {
      return;
    }
    this.uiVisible = visible;
    this.syncTimer();
  }

  public onConfigChanged(): void {
    const wasEnabled = this.config.enabled;
    this.config = getTtlConfig();
    if (wasEnabled && !this.config.enabled) {
      this.tracked = [];
      this.rendered = [];
      this.prevState.clear();
      this.lastRequestSeen.clear();
      this.emitter.fire(this.rendered);
    }
    this.syncTimer();
  }

  /**
   * Refresh tracked sessions from an already-completed scan. Data-only — the
   * scan did the I/O, this just reshapes what is already in memory.
   */
  public ingest(scan: ScanResult | undefined, cli: CliScanResult | undefined): void {
    if (!this.config.enabled) {
      return;
    }
    const now = Date.now();
    const windowMs = (maxTimerValue(this.config.ttlMap) + this.config.expiredGraceSeconds) * 1000;
    const next: TrackedSession[] = [];

    // Cache-read tokens live on turns, not sessions — roll them up once.
    const cachedBySession = new Map<string, number>();
    for (const t of scan?.turns ?? []) {
      if (t.debugCachedTokens > 0) {
        cachedBySession.set(
          t.sessionId,
          (cachedBySession.get(t.sessionId) ?? 0) + t.debugCachedTokens
        );
      }
    }

    for (const s of scan?.sessions ?? []) {
      const t = this.trackVsCode(s, now, windowMs, cachedBySession.get(s.sessionId) ?? 0);
      if (t) {
        next.push(t);
      }
    }
    for (const c of cli?.sessions ?? []) {
      if (!c.lastTs || now - c.lastTs > windowMs) {
        continue;
      }
      const provider = mapTtlProvider(c.primaryModel);
      next.push({
        sessionId: `cli:${c.sessionId}`,
        title: shortTitle(cliTitle(c.cwd, c.sessionId)),
        source: "cli",
        lastRequestMs: c.lastTs,
        // The CLI event log has no turn_start/turn_end markers, so HOT falls
        // back to the post-request grace window in computeWorking().
        lastTurnStartMs: 0,
        lastTurnEndMs: 0,
        model: c.primaryModel || "",
        provider,
        costUsd: c.totalAic * this.dollarPerCredit(),
        cacheHitPct: cliCacheHitPct(c),
      });
    }

    this.tracked = next.slice(0, MAX_TRACKED);
    this.syncTimer();
    this.tick();
  }

  private trackVsCode(
    s: Session,
    now: number,
    windowMs: number,
    cachedTokens: number
  ): TrackedSession | undefined {
    // Anchor on the newest llm_request; a session with no debug-log has no
    // per-request timing and therefore no meaningful cache countdown.
    const lastRequestMs = s.lastRequestMs;
    if (!lastRequestMs || now - lastRequestMs > windowMs) {
      return undefined;
    }
    const model = s.lastRequestModel || s.modelFamily || s.modelName || "";
    const cacheHit = computeCacheHit(s.debugTotalPrompt, cachedTokens);
    return {
      sessionId: s.sessionId,
      title: shortTitle(s.sessionTitle || s.promptPreview || s.projectName || s.sessionId),
      source: "vscode",
      lastRequestMs,
      lastTurnStartMs: s.lastTurnStartMs,
      lastTurnEndMs: s.lastTurnEndMs,
      model,
      provider: mapTtlProvider(model),
      costUsd: s.debugTotalAicCredits * this.dollarPerCredit(),
      cacheHitPct: cacheHit.pct,
    };
  }

  /** Start or stop the one-second tick to match enabled + visibility. */
  private syncTimer(): void {
    const shouldRun = this.config.enabled && this.uiVisible && this.tracked.length > 0;
    if (shouldRun && !this.tickHandle) {
      this.tickHandle = setInterval(() => this.tick(), 1000);
    } else if (!shouldRun && this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
  }

  /** Pure arithmetic over cached timestamps. No I/O. */
  private tick(): void {
    if (!this.config.enabled) {
      return;
    }
    const now = Date.now();
    const out: SessionTtl[] = [];

    for (const t of this.tracked) {
      const th = getTtlThresholds(t.provider, this.config.ttlMap);
      if (
        !isWithinActiveWindow(t.lastRequestMs, now, th.timerValue, this.config.expiredGraceSeconds)
      ) {
        continue;
      }
      const working = computeWorking(
        {
          lastTurnStartMs: t.lastTurnStartMs,
          lastTurnEndMs: t.lastTurnEndMs,
          lastRequestMs: t.lastRequestMs,
        },
        now,
        this.config.workingGraceSeconds
      );
      const remaining = computeRemaining(th.timerValue, now, t.lastRequestMs);
      const state = computeState(working, remaining, th.warnAt, th.alertAt);
      out.push({
        sessionId: t.sessionId,
        title: t.title,
        source: t.source,
        lastRequestMs: t.lastRequestMs,
        working,
        model: t.model,
        provider: t.provider,
        timerValue: th.timerValue,
        warnAt: th.warnAt,
        alertAt: th.alertAt,
        costUsd: t.costUsd,
        cacheHitPct: t.cacheHitPct,
        remaining,
        state,
      });
    }

    out.sort(urgencyCompare);
    for (const s of out) {
      this.maybeAlert(s);
    }
    this.prune(out);

    this.rendered = out;
    this.syncTimer();
    this.emitter.fire(this.rendered);
  }

  private maybeAlert(session: SessionTtl): void {
    // A brand-new request re-arms the alert so the next expiry chimes again.
    const seen = this.lastRequestSeen.get(session.sessionId);
    if (seen !== undefined && session.lastRequestMs > seen) {
      this.prevState.delete(session.sessionId);
    }
    this.lastRequestSeen.set(session.sessionId, session.lastRequestMs);

    const decision = alertDecision(this.prevState.get(session.sessionId), session.state, {
      soundEnabled: this.config.soundEnabled,
      notifyOnRed: this.config.notifyOnRed,
    });
    if (decision.playSound) {
      const sound = resolveSoundPath(this.config.soundPath, this.bundledSoundPath);
      this.queue.enqueue(sound, process.platform, this.config.alertRepeat);
    }
    if (decision.notify) {
      void vscode.window.showWarningMessage(
        `Prompt cache expiring — "${session.title}" (${session.provider}) has ${formatTtl(
          session.remaining
        )} left.`
      );
    }
    this.prevState.set(session.sessionId, session.state);
  }

  private prune(live: SessionTtl[]): void {
    const ids = new Set(live.map(s => s.sessionId));
    for (const id of Array.from(this.prevState.keys())) {
      if (!ids.has(id)) {
        this.prevState.delete(id);
      }
    }
    for (const id of Array.from(this.lastRequestSeen.keys())) {
      if (!ids.has(id)) {
        this.lastRequestSeen.delete(id);
      }
    }
  }

  public dispose(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    this.emitter.dispose();
  }
}

/** CLI sessions have no chat title — use the working directory's leaf name. */
function cliTitle(cwd: string, sessionId: string): string {
  const leaf = (cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return leaf ? `CLI · ${leaf}` : `CLI · ${sessionId.slice(0, 8)}`;
}

function cliCacheHitPct(c: { byModel: Record<string, { ledgerInputTokens?: number; ledgerCacheReadTokens?: number }> }): number {
  let input = 0;
  let cached = 0;
  for (const m of Object.values(c.byModel ?? {})) {
    input += m.ledgerInputTokens ?? 0;
    cached += m.ledgerCacheReadTokens ?? 0;
  }
  return computeCacheHit(input, cached).pct;
}
