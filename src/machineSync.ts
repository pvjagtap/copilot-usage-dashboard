/**
 * machineSync.ts — Cross-machine usage aggregation over Settings Sync.
 *
 * Usage itself is never synced as raw data: every figure on the dashboard is
 * derived by scanning local files (`workspaceStorage`, `~/.omp`, `~/.pi`,
 * Copilot debug logs) that only exist on the machine that produced them. What
 * this module syncs is a compact per-machine *rollup* — credits by day, by
 * model, and a few counters — so a second machine can show a combined total
 * without ever seeing the other machine's logs or prompts.
 *
 * Merge model. VS Code's extensions synchroniser applies incoming state per
 * declared key with `local[key] = remote[key]` — a replace, not a merge (see
 * `updateExtensionState` in the shared process). A single flat usage blob
 * would therefore let whichever machine synced last erase the others. The
 * payload is instead a map keyed by `vscode.env.machineId`, and a machine only
 * ever writes its own slot after re-reading the map. Each machine is the sole
 * author of its own slot, so a lost race costs at most one refresh interval.
 */
import * as vscode from "vscode";
import * as os from "os";
import { CATALOG_SYNC_KEY } from "./modelCatalog";

/**
 * globalState key for the per-machine usage rollups.
 *
 * Deliberately unversioned: bumping it would hide every machine that has not
 * upgraded yet, and a machine only republishes when its own VS Code restarts.
 * Slots carry `schema` instead, so a stale rollup still identifies its system.
 */
const MACHINES_KEY = "copilotUsage.usage.machines.v1";

/**
 * Slot format this build writes.
 *
 * 1 — `cycleCredits` held `aicSummary.totalCredits`, which on a pooled seat is
 *     GitHub's account-wide ledger, not the machine's own usage. Unusable in a
 *     sum: every machine reported the whole account.
 * 2 — `cycleCredits` is machine-local, and the counters are clipped to the
 *     billing cycle.
 */
const SLOT_SCHEMA = 2;

/** Days of daily history retained per machine — bounds the synced payload. */
const RETAIN_DAYS = 120;

/** A machine with no update for this long is reported as dormant. */
const DORMANT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum gap between writes of our own slot.
 *
 * The dashboard rebuilds whenever a request lands, and every `globalState`
 * write schedules a sync attempt. Enough of them in a row and the sync service
 * raises `LocalTooManyRequests`, which sets `suspendUntilRestart` and kills
 * auto-sync for the rest of the session. Throttling costs nothing here — the
 * rollup is a slow-moving daily aggregate.
 */
const PUBLISH_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastPublishAt = 0;
let lastPublishFingerprint = "";

/** The rollup one machine publishes about itself. */
export interface MachineSlot {
  /** `os.hostname()` — so a system is recognisable beyond "System 2". */
  host: string;
  platform: string;
  firstSeen: number;
  lastSeen: number;
  /** Billing cycle this snapshot describes, so stale cycles aren't summed. */
  cycleStart: string;
  cycleCredits: number;
  sessions: number;
  turns: number;
  totalTokens: number;
  /** `YYYY-MM-DD` → credits. Trimmed to `RETAIN_DAYS`. */
  byDay: Record<string, number>;
  /** model id → credits in the current cycle. */
  byModel: Record<string, number>;
  /** Absent on slots written before the local-credits fix — see `SLOT_SCHEMA`. */
  schema?: number;
}

/** A slot decorated for display. */
export interface MachineView extends MachineSlot {
  id: string;
  /** 1-based, ordered by `firstSeen` so numbering is identical everywhere. */
  systemNo: number;
  label: string;
  isThisMachine: boolean;
  dormant: boolean;
  /**
   * Whether `cycleCredits` describes this machine alone. False for pre-fix
   * slots, whose figure is the whole account's — render the system, withhold
   * the number, and leave it out of any sum.
   */
  creditsAreLocal: boolean;
}

/** What the caller measured locally this refresh. */
export interface LocalUsage {
  cycleStart: string;
  cycleCredits: number;
  sessions: number;
  turns: number;
  totalTokens: number;
  byDay: Record<string, number>;
  byModel: Record<string, number>;
}

/**
 * Declares every synced key in one call.
 *
 * `setKeysForSync` replaces the extension's whole declared-key list rather
 * than appending, so it must have exactly one caller — otherwise the last
 * module to run silently drops the other's key.
 */
export function registerSyncKeys(ctx: vscode.ExtensionContext): void {
  try {
    ctx.globalState.setKeysForSync([CATALOG_SYNC_KEY, MACHINES_KEY]);
  } catch {
    // Restricted host / older API — sync is a bonus, never required.
  }
}

function trimDays(byDay: Record<string, number>): Record<string, number> {
  const days = Object.keys(byDay).sort();
  if (days.length <= RETAIN_DAYS) return byDay;
  const keep = days.slice(days.length - RETAIN_DAYS);
  const out: Record<string, number> = {};
  for (const d of keep) out[d] = byDay[d];
  return out;
}

/**
 * Folds this refresh's daily credits into what the slot already held.
 *
 * A plain replace loses history the scan can no longer see: debug logs rotate,
 * workspaceStorage folders get cleaned up, and a closed cycle's days stop
 * being recomputed — so days that were published correctly would silently
 * disappear on the next write, and `RETAIN_DAYS` never applied to anything.
 *
 * A recomputed day supersedes the stored one, but only when it is non-zero:
 * zero means "this scan can no longer see that day", not "nothing was spent".
 */
function mergeDays(
  prior: Record<string, number> | undefined,
  local: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...(prior ?? {}) };
  for (const [day, credits] of Object.entries(local)) {
    if (credits > 0) out[day] = credits;
    else if (out[day] === undefined) out[day] = 0;
  }
  return trimDays(out);
}

/**
 * Writes this machine's slot and returns every known machine, ordered and
 * labelled. Read-modify-write so a synced update from another machine is
 * preserved rather than overwritten.
 */
export function publishAndRead(
  ctx: vscode.ExtensionContext,
  local: LocalUsage
): MachineView[] {
  const id = vscode.env.machineId;
  const now = Date.now();
  const map = { ...(ctx.globalState.get<Record<string, MachineSlot>>(MACHINES_KEY) ?? {}) };
  const prior = map[id];

  // Nothing meaningful changed, or we wrote very recently — read only. The
  // returned view still reflects whatever other machines have synced in.
  const fingerprint = `${local.cycleStart}|${local.cycleCredits}|${local.sessions}|${local.turns}`;
  const skip =
    !!prior &&
    (fingerprint === lastPublishFingerprint || now - lastPublishAt < PUBLISH_MIN_INTERVAL_MS);
  if (skip) return decorate(map, id, now);

  map[id] = {
    host: os.hostname(),
    platform: process.platform,
    firstSeen: prior?.firstSeen ?? now,
    lastSeen: now,
    cycleStart: local.cycleStart,
    cycleCredits: local.cycleCredits,
    sessions: local.sessions,
    turns: local.turns,
    totalTokens: local.totalTokens,
    byDay: mergeDays(prior?.byDay, local.byDay),
    byModel: local.byModel,
    schema: SLOT_SCHEMA,
  };

  lastPublishAt = now;
  lastPublishFingerprint = fingerprint;
  void ctx.globalState.update(MACHINES_KEY, map);
  return decorate(map, id, now);
}

/** Test seam: clears the publish throttle. */
export function __resetThrottleForTesting(): void {
  lastPublishAt = 0;
  lastPublishFingerprint = "";
}

/** Reads without publishing — for consumers that only render. */
export function readMachines(ctx: vscode.ExtensionContext): MachineView[] {
  const map = ctx.globalState.get<Record<string, MachineSlot>>(MACHINES_KEY) ?? {};
  return decorate(map, vscode.env.machineId, Date.now());
}

function decorate(
  map: Record<string, MachineSlot>,
  thisId: string,
  now: number
): MachineView[] {
  return Object.entries(map)
    .filter(([, s]) => s && typeof s.firstSeen === "number")
    // firstSeen is part of the synced slot, so every machine derives the same
    // ordering and "System 2" means the same system on all of them.
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen || a[0].localeCompare(b[0]))
    .map(([id, slot], i) => ({
      ...slot,
      id,
      systemNo: i + 1,
      label: `System ${i + 1}`,
      isThisMachine: id === thisId,
      dormant: now - slot.lastSeen > DORMANT_MS,
      creditsAreLocal: (slot.schema ?? 1) >= SLOT_SCHEMA,
    }));
}

/** Sums slots that describe the same billing cycle. */
export function combinedCredits(views: MachineView[], cycleStart: string): number {
  const total = views
    .filter(v => v.cycleStart === cycleStart && v.creditsAreLocal)
    .reduce((s, v) => s + (v.cycleCredits || 0), 0);
  return Math.round(total * 100) / 100;
}
