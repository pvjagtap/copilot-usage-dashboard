/**
 * quotaSnapshot.ts — GitHub's own AI-credit ledger.
 *
 * Every other number in this extension is reconstructed from local debug
 * logs. That reconstruction is structurally incomplete:
 *
 *   • Requests billed on another machine, in another IDE, on github.com,
 *     or by the cloud agent never produce a local `main.jsonl`.
 *   • Requests dispatched through VS Code's public `LanguageModelChat`
 *     wrapper (`debugName: "copilotLanguageModelWrapper"`) omit
 *     `copilotUsageNanoAiu` entirely, so they can only ever be rate-estimated.
 *   • Rotated / deleted debug logs take their credits with them.
 *
 * `GET /copilot_internal/user` is the same endpoint the official Copilot
 * extension polls to render its own quota UI. Its `quota_snapshots` block
 * carries the server-side truth:
 *
 *   quota_snapshots.premium_interactions = {
 *     quota_id:            "premium_interactions",
 *     credits_used:        <number>,   // AIC consumed this cycle
 *     entitlement:         <number>,   // pooled AIC available this cycle
 *     remaining:           <number>,
 *     overage_count:       <number>,
 *     overage_permitted:   true,
 *     token_based_billing: true,       // false ⇒ legacy premium-request seat
 *     timestamp_utc:       "…"
 *   }
 *
 * Under usage-based billing GitHub reuses the `premium_interactions` quota id
 * for AI credits — `token_based_billing: true` is what marks the values as
 * AIC rather than legacy premium-request counts.
 *
 * We treat `credits_used` as authoritative for the headline total and keep
 * the locally-derived breakdown for attribution (per model, per day, per
 * session), which the API does not provide.
 *
 * Note: on a pooled Business/Enterprise plan `entitlement` is the *pooled*
 * allowance visible to this seat, so it can read orders of magnitude above
 * the per-user figure in `DEFAULT_PLANS`.
 */

import * as vscode from "vscode";

/** Cache TTL — the endpoint updates within a minute or two of real usage. */
const TTL_MS = 5 * 60 * 1000;

const ENDPOINT = "https://api.github.com/copilot_internal/user";

export interface QuotaSnapshot {
  /** AI credits GitHub has billed this cycle — authoritative. */
  creditsUsed: number;
  /** AI credits available this cycle (pooled for org plans). */
  entitlement: number;
  /** Credits left before overage begins. */
  remaining: number;
  /** Credits consumed beyond `entitlement`. */
  overageCount: number;
  /** Whether spend beyond the entitlement is allowed. */
  overagePermitted: boolean;
  /** ISO date the quota resets (start of next cycle). */
  quotaResetDate?: string;
  /** Server timestamp for the snapshot. */
  timestampUtc?: string;
  /** When we fetched it (epoch ms). */
  fetchedAt: number;
}

interface QuotaSnapshotWire {
  credits_used?: number;
  entitlement?: number;
  remaining?: number;
  overage_count?: number;
  overage_permitted?: boolean;
  token_based_billing?: boolean;
  timestamp_utc?: string;
}

interface CopilotUserWire {
  quota_reset_date?: string;
  quota_snapshots?: Record<string, QuotaSnapshotWire>;
  token_based_billing?: boolean;
}

type LogFn = (msg: string) => void;

let cached: QuotaSnapshot | null = null;

/** Last snapshot fetched, without triggering a network call. */
export function getCachedQuotaSnapshot(): QuotaSnapshot | null {
  return cached;
}

/** Drop the cache so the next `fetchQuotaSnapshot` re-queries. Test hook. */
export function clearQuotaSnapshotCache(): void {
  cached = null;
}

/**
 * Pick the AI-credit quota out of a `/copilot_internal/user` payload.
 *
 * Exported so it can be unit-tested against recorded payloads without a
 * network call or a `vscode` session.
 */
export function parseQuotaSnapshot(body: unknown): QuotaSnapshot | null {
  const user = body as CopilotUserWire | null;
  const snapshots = user?.quota_snapshots;
  if (!snapshots || typeof snapshots !== "object") {
    return null;
  }

  // `premium_interactions` is the AIC bucket under usage-based billing;
  // scan the rest as a hedge against GitHub renaming the quota id.
  const ordered = [
    snapshots["premium_interactions"],
    ...Object.entries(snapshots)
      .filter(([id]) => id !== "premium_interactions")
      .map(([, snap]) => snap),
  ];

  for (const snap of ordered) {
    if (!snap || typeof snap !== "object") {
      continue;
    }
    // `chat` / `completions` report token_based_billing too but are unlimited
    // and always read zero — an entitlement is what marks the real AIC bucket.
    const entitlement = Number(snap.entitlement ?? 0);
    const creditsUsed = Number(snap.credits_used ?? 0);
    if (entitlement <= 0 && creditsUsed <= 0) {
      continue;
    }
    if (snap.token_based_billing !== true) {
      continue;
    }
    return {
      creditsUsed,
      entitlement,
      remaining: Number(snap.remaining ?? Math.max(0, entitlement - creditsUsed)),
      overageCount: Number(snap.overage_count ?? 0),
      overagePermitted: snap.overage_permitted === true,
      quotaResetDate: typeof user?.quota_reset_date === "string" ? user.quota_reset_date : undefined,
      timestampUtc: typeof snap.timestamp_utc === "string" ? snap.timestamp_utc : undefined,
      fetchedAt: Date.now(),
    };
  }
  return null;
}

/**
 * Reuse whatever GitHub session VS Code already cached. Silent only — this
 * runs on every refresh, so it must never prompt. `planDetector` owns the
 * one-time consent flow; once the user has granted it, these silent calls
 * succeed for good.
 */
async function silentSession(): Promise<vscode.AuthenticationSession | undefined> {
  const scopeCandidates: string[][] = [
    ["read:user"],
    ["user:email"],
    ["repo", "workflow", "read:user"],
    ["repo"],
  ];
  for (const scopes of scopeCandidates) {
    try {
      const s = await vscode.authentication.getSession("github", scopes, {
        silent: true,
        createIfNone: false,
      });
      if (s) {
        return s;
      }
    } catch {
      // Try the next scope set.
    }
  }
  return undefined;
}

/**
 * Fetch GitHub's authoritative credit ledger for the current cycle.
 *
 * Returns `null` on any failure (offline, no session, endpoint moved) so
 * callers transparently fall back to the locally-derived total. Never throws.
 */
export async function fetchQuotaSnapshot(
  log: LogFn,
  force = false,
): Promise<QuotaSnapshot | null> {
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached;
  }

  const session = await silentSession();
  if (!session) {
    log("quotaSnapshot: no silent GitHub session — skipping");
    return cached;
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "vscode-copilot-usage-dashboard",
      },
    });
    if (!res.ok) {
      log(`quotaSnapshot: ${ENDPOINT} returned ${res.status}`);
      return cached;
    }
    const snapshot = parseQuotaSnapshot(await res.json());
    if (!snapshot) {
      log("quotaSnapshot: response carried no token-based quota bucket");
      return cached;
    }
    cached = snapshot;
    log(
      `quotaSnapshot: credits_used=${snapshot.creditsUsed} entitlement=${snapshot.entitlement} remaining=${snapshot.remaining}`,
    );
    return snapshot;
  } catch (err) {
    log(`quotaSnapshot: fetch error — ${String(err)}`);
    return cached;
  }
}
