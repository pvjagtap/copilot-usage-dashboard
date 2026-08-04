/**
 * modelCatalog.ts — Authoritative GitHub Copilot model catalog.
 *
 * Background — issue #5 follow-up research:
 *
 *   The classifier `classifyModelBillability()` in `aicCredits.ts` ultimately
 *   falls back to a substring match against the built-in `DEFAULT_MODEL_COSTS`
 *   rate table to decide whether GitHub bills a given model. That table is
 *   maintained manually from
 *   <https://docs.github.com/en/copilot/reference/ai-models/supported-models>,
 *   so any newly-released preview model (e.g. "claude-fable-5") looks
 *   "unknown" until we ship a new extension version.
 *
 *   This module hardens that decision by reading two Microsoft-published
 *   sources used by the official Copilot Chat extension itself:
 *
 *     1. The Copilot CAPI `/models` endpoint — the AUTHORITATIVE billing source.
 *        <https://api.individual.githubcopilot.com/models>
 *        Called after exchanging the user's GitHub OAuth token for a Copilot
 *        internal token at <https://api.github.com/copilot_internal/v2/token>.
 *        The response is `{ data: IModelAPIResponse[] }`. Each entry includes
 *        a `billing: { is_premium, multiplier, restricted_to? }` field that
 *        is the canonical "does GitHub bill this model" signal:
 *
 *           billing.multiplier > 0  → billable to AI Credits
 *           billing absent / 0      → not billed (free/utility)
 *
 *        We re-use the same silent-session pattern as `planDetector.ts`
 *        so we never prompt the user.
 *
 *     2. The CDN-hosted BYOK known-models manifest — informational only.
 *        <https://main.vscode-cdn.net/extensions/copilotChat.json>
 *        Same URL `BYOKContrib.fetchKnownModelList()` in
 *        `microsoft/vscode-copilot-chat` reads on startup. Despite the
 *        misleading top-level name, the schema
 *          { version: 1, modelInfo: { [provider]: { [modelId]: caps } } }
 *        contains ONLY BYOK provider keys (OpenAI, Anthropic, Gemini, Groq,
 *        xAI — verified via `tests/verify-online-catalog.ts`). It carries
 *        capability metadata for BYOK keys; it does NOT enumerate Copilot's
 *        billable model set. We track which provider lists a given id (for
 *        diagnostics) but DO NOT use it to decide billability — the same id
 *        often appears in both BYOK lists AND the Copilot CAPI response
 *        (e.g. `claude-opus-4-7`), and demoting it based on CDN data alone
 *        would wrongly classify real Copilot traffic.
 *
 * Both sources are network calls — wrapped in 24h disk cache in
 * `globalState`, best-effort (failures fall back silently to the
 * built-in `DEFAULT_MODEL_COSTS` heuristic), and can be disabled via the
 * `copilotUsage.aic.useOnlineModelCatalog` setting.
 *
 * Lifecycle:
 *   • `loadCatalog()` is called once at extension activation.
 *   • The returned set/map is exposed via `getCachedCatalog()` so the
 *     classifier can consult it synchronously on every credit entry.
 *   • A refresh runs once per 24 hours (or on demand), and immediately when
 *     `notifyUnknownModel()` reports an id the snapshot cannot resolve —
 *     a miss is the only direct evidence that the snapshot predates a
 *     newly-shipped model, and waiting out the TTL would mispriced it for
 *     up to a day.
 */

import * as vscode from "vscode";
import {
  parseUserChatLanguageModels,
  mergeThirdPartyMaps,
} from "./chatLanguageModelsParser";

// ─── Constants ────────────────────────────────────────────────

/** Known-models manifest used by Copilot Chat's BYOKContrib. */
const KNOWN_MODELS_URL = "https://main.vscode-cdn.net/extensions/copilotChat.json";

/** Copilot internal token mint endpoint — same one `planDetector.ts` uses. */
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * Fallback CAPI host used only if the token response is missing the
 * `endpoints.api` field. The real host comes back per-plan in the token
 * envelope (e.g. `api.business.githubcopilot.com` for Business,
 * `api.enterprise.githubcopilot.com` for Enterprise, `api.individual…`
 * for Individual). See `TokenEnvelope` / `Endpoints` in
 * microsoft/vscode-copilot-chat `src/platform/authentication/common/copilotToken.ts`.
 */
const FALLBACK_CAPI_HOST = "https://api.individual.githubcopilot.com";

/**
 * Scope sets the official Copilot extension is known to mint sessions with.
 * Matches the candidate list in `planDetector.ts/trySilentSession()` so a
 * session created for plan detection is reused here without a second prompt.
 */
const SCOPE_CANDIDATES: string[][] = [
  ["read:user"],
  ["user:email"],
  ["repo", "workflow", "read:user"],
  ["repo"],
];

/** How long a successful catalog is considered fresh. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** A cache miss only forces a refresh once the snapshot is at least this old. */
const MISS_REFRESH_MIN_AGE_MS = 15 * 60 * 1000;

/** globalState key for the machine-local part of the catalog. */
const CATALOG_CACHE_KEY = "copilotUsage.aic.modelCatalog.v1";

/**
 * Schema version of the persisted `userVendorByModelId` map. Bump whenever
 * the parser can extract ids a previous build could not, so an upgrade
 * doesn't sit on a cached map for up to `CATALOG_TTL_MS` still missing them.
 *
 *   1 — `settings` keys only.
 *   2 — also reads the documented `models[]` array, and keeps ids declared
 *       under several non-Copilot vendors as `"multiple"` instead of
 *       dropping them.
 */
const VENDOR_MAP_VERSION = 2;

/**
 * globalState key for the account-scoped part of the catalog (CAPI rates +
 * CDN provider lists), declared to Settings Sync so every machine signed into
 * the same account converges on one snapshot.
 *
 * Deliberately excludes `userVendorByModelId`: that map is built from this
 * machine's `chatLanguageModels.json` and its live `vscode.lm` registry, so
 * syncing it would tag a model as third-party on a machine where no such
 * provider exists — which feeds `classify()` and flips rows between billable
 * and non-billable.
 *
 * Declared to Settings Sync by `machineSync.registerSyncKeys()`, which owns
 * the single `setKeysForSync` call.
 */
export const CATALOG_SYNC_KEY = "copilotUsage.aic.modelCatalogRates.v1";

/** Default User-Agent — matches what `planDetector.ts` sends. */
const USER_AGENT = "vscode-copilot-usage-dashboard";

// ─── Types ────────────────────────────────────────────────────

/**
 * The shape of the CDN `copilotChat.json` payload (only the fields we read).
 * Mirrors `BYOKContrib.fetchKnownModelList()` in microsoft/vscode-copilot-chat
 * (`src/extension/byok/vscode-node/byokContribution.ts`).
 */
interface KnownModelsManifest {
  version: number;
  modelInfo: Record<string, Record<string, unknown>>;
}

/**
 * One entry from the Copilot CAPI `/models` response. Mirrors
 * `IModelAPIResponse` in microsoft/vscode-copilot-chat
 * (`src/platform/endpoint/common/endpointProvider.ts`).
 *
 * Verified against a live business-plan response 2026-07-29:
 *   billing = { restricted_to[], token_prices: { default, long_context? } }
 * The legacy `billing.multiplier` / `billing.is_premium` fields are gone —
 * premium tier is signalled by `model_picker_price_category` and billability
 * by `token_prices.default.input_price > 0`.
 */
interface CapiModelResponse {
  id: string;
  vendor?: string;
  name?: string;
  model_picker_enabled?: boolean;
  model_picker_price_category?: "low" | "medium" | "high" | "very_high" | string;
  preview?: boolean;
  billing?: {
    restricted_to?: string[];
    token_prices?: {
      batch_size?: number;
      default?: TokenPriceBlock;
      long_context?: TokenPriceBlock;
    };
  };
}

/**
 * Rate block inside `billing.token_prices.default` / `.long_context`.
 * All values are AI Credits per 1M tokens. Zero means free/utility.
 */
interface TokenPriceBlock {
  input_price?: number;
  output_price?: number;
  cache_price?: number;
  cache_write_price?: number;
  context_max?: number;
}

/**
 * One billability fact about a model. Only entries with a definitive
 * `source: "capi"` are returned to the classifier — those are the only
 * entries whose `billable` flag is authoritative.
 *
 *  • `source: "capi"` — `multiplier` came from the Copilot CAPI `/models`
 *                       response. `billable === (multiplier > 0)`. This is
 *                       the ONLY source the classifier trusts.
 *
 * CDN-derived metadata (provider lists from `copilotChat.json`) is captured
 * in `ModelCatalog.cdnProviders` for diagnostics but never fed to
 * `classifyByCatalog()` — because the CDN file contains only BYOK provider
 * lists and the same model id (e.g. `claude-opus-4-7`) routinely appears in
 * both the BYOK list AND Copilot's billable set. Demoting based on CDN data
 * alone would wrongly classify real Copilot traffic. Verified via
 * `tests/verify-online-catalog.ts`.
 */
export interface ModelCatalogEntry {
  id: string;
  billable: boolean;
  /** Declared under a non-Copilot vendor and absent from a loaded CAPI snapshot. */
  exclusiveThirdParty?: boolean;
  /**
   * The user declared this id under a non-Copilot vendor, regardless of
   * whether CAPI also serves it. Set even on `source: "capi"` entries, so a
   * colliding id can still be split per request by its routing evidence.
   */
  userThirdParty?: boolean;
  multiplier?: number;
  isPremium?: boolean;
  preview?: boolean;
  vendor?: string;
  /** Per-1M token rates parsed from CAPI billing.price when present. */
  rates?: {
    inputCreditsPerMillion: number;
    outputCreditsPerMillion: number;
    cachedInputCreditsPerMillion: number;
    cacheWriteCreditsPerMillion: number;
  };
  /**
   * Maximum input tokens the model accepts, sourced from CAPI's
   * `billing.token_prices.long_context.context_max` (preferred, real ceiling)
   * with `default.context_max` fallback. Undefined when CAPI omits it.
   */
  contextMax?: number;
  /**
   *  • `"capi"`        — entry came from the Copilot CAPI `/models` response.
   *                       `billable === (multiplier > 0)`.
   *  • `"user-config"` — entry was synthesised from the user's local
   *                       `chatLanguageModels.json`. Always `billable=false`
   *                       (vendor ≠ copilot).
   */
  source: "capi" | "user-config";
}

/** In-memory snapshot of the catalog. */
export interface ModelCatalog {
  fetchedAt: number;
  /** Lower-cased model id → entry (CAPI-derived only). */
  byId: Map<string, ModelCatalogEntry>;
  /** Provider → set of model ids from the CDN BYOK manifest. Diagnostics only. */
  cdnProviders: Record<string, string[]>;
  /**
   * Lower-cased model id → vendor name, drawn from the user's local
   * `<UserDir>/chatLanguageModels.json` (the file VS Code writes when the
   * user configures a chat-model provider). Only entries where the vendor
   * is NOT `copilot` and the id appears under exactly one vendor are
   * recorded — i.e. unambiguous third-party model associations such as
   * `ollama`, `anthropic` (BYOK), `lmstudio`. A hit here is treated as an
   * authoritative "non-billable" signal by `classifyByCatalog()`.
   */
  userVendorByModelId: Map<string, string>;
}

/** The account-scoped subset written to `CATALOG_SYNC_KEY`. */
interface SyncedCatalogPayload {
  fetchedAt: number;
  entries: ModelCatalogEntry[];
  cdnProviders: Record<string, string[]>;
}

interface CatalogCachePayload {
  fetchedAt: number;
  /** `VENDOR_MAP_VERSION` the map was built with; absent on pre-v2 payloads. */
  vendorMapVersion?: number;
  /** Persisted form of `ModelCatalog.userVendorByModelId`. */
  userVendorByModelId?: Array<[string, string]>;
  /** Pre-split payloads carried the rates here too; read for migration only. */
  entries?: ModelCatalogEntry[];
  cdnProviders?: Record<string, string[]>;
}

type LogFn = (msg: string) => void;

// ─── Module state ─────────────────────────────────────────────

let cached: ModelCatalog | null = null;

/** Captured by `loadCatalog()` so a cache miss can refresh without plumbing. */
let refreshCtx: { ctx: vscode.ExtensionContext; log: LogFn } | null = null;

/** Unknown ids seen this session — each may force at most one refresh. */
const notifiedUnknownIds = new Set<string>();

let refreshInFlight = false;

// ─── Public API ───────────────────────────────────────────────

/**
 * Returns the in-memory catalog snapshot, or `null` if it has not been
 * loaded yet (or loading failed). Synchronous on purpose so it can be
 * consulted from inside `classifyModelBillability()`.
 */
export function getCachedCatalog(): ModelCatalog | null {
  return cached;
}

/**
 * Resolve per-1M token rates for `modelId` from the live catalog.
 * Returns `null` when the catalog hasn't loaded yet, the model isn't in
 * CAPI, or CAPI didn't publish rates for it — callers must fall back to
 * their static rate table in that case.
 *
 * The returned shape matches `ModelCostRate` (imported by callers) so
 * `AICCalculator.findModelRate()` can consume it directly.
 */
export function getRatesFor(modelId: string): {
  model: string;
  inputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  cachedInputCreditsPerMillion: number;
  cacheWriteCreditsPerMillion: number;
  tier: "base" | "premium";
} | null {
  if (!cached) return null;
  const key = modelId.toLowerCase().replace(/(\d)-(\d)/g, "$1.$2");
  // Try both hyphen and dot forms since CAPI ids and OTel-reported ids differ.
  const entry = cached.byId.get(key) ?? cached.byId.get(modelId.toLowerCase());
  if (!entry?.rates) return null;
  return {
    model: entry.id,
    inputCreditsPerMillion: entry.rates.inputCreditsPerMillion,
    outputCreditsPerMillion: entry.rates.outputCreditsPerMillion,
    cachedInputCreditsPerMillion: entry.rates.cachedInputCreditsPerMillion,
    cacheWriteCreditsPerMillion: entry.rates.cacheWriteCreditsPerMillion,
    tier: entry.isPremium ? "premium" : "base",
  };
}

/**
 * Extract per-1M rates from `billing.token_prices.default`. We use the
 * `default` block (matches what VS Code's Language Models view displays);
 * `long_context` is a separate rate tier that kicks in above the model's
 * `default.context_max` and would need per-request context-size tracking
 * to apply correctly. Returns null when no default block is present or all
 * prices are 0 (free / utility / deprecated models).
 */
function extractRatesFromCapi(m: CapiModelResponse): ModelCatalogEntry["rates"] {
  const def = m.billing?.token_prices?.default;
  if (!def) return undefined;
  const input = def.input_price ?? 0;
  const output = def.output_price ?? 0;
  if (input === 0 && output === 0) return undefined;
  return {
    inputCreditsPerMillion: input,
    outputCreditsPerMillion: output,
    cachedInputCreditsPerMillion: def.cache_price ?? 0,
    cacheWriteCreditsPerMillion: def.cache_write_price ?? 0,
  };
}

/**
 * True maximum input tokens for the model — prefer `long_context.context_max`
 * (the actual ceiling used when the client opts into extended context, e.g.
 * Claude's 1M mode), fall back to `default.context_max` (the standard tier).
 * Undefined when CAPI omits it, which happens for some legacy / preview models.
 */
function extractContextMaxFromCapi(m: CapiModelResponse): number | undefined {
  const long = m.billing?.token_prices?.long_context?.context_max;
  const def = m.billing?.token_prices?.default?.context_max;
  return long ?? def;
}

/**
 * Public lookup of a model's context_max, tolerant to id shape variance
 * between CAPI (`claude-opus-4.7`) and OTel (`claude-opus-4-7`, etc.).
 * Returns undefined when the catalog is not yet loaded or the model has
 * no reported context_max.
 */
export function getContextMaxFor(modelId: string): number | undefined {
  const cached = getCachedCatalog();
  if (!cached || !modelId) return undefined;
  const dotForm = modelId.toLowerCase().replace(/(\d)-(\d)/g, "$1.$2");
  const entry = cached.byId.get(dotForm) ?? cached.byId.get(modelId.toLowerCase());
  return entry?.contextMax;
}

/**
 * Test-only: replace the in-memory catalog snapshot. Lets unit tests
 * exercise `classifyByCatalog()` without performing a real network refresh
 * or hitting the VS Code globalState cache. Production code must not call
 * this — use `loadCatalog()` instead.
 */
export function __setCatalogForTesting(snapshot: ModelCatalog | null): void {
  cached = snapshot;
}

/**
 * Report a model id that neither the live catalog nor the static rate table
 * could resolve, forcing a refresh rather than waiting out the 24h TTL.
 *
 * Debounced three ways: each id reports once per session, only one refresh
 * runs at a time, and a snapshot younger than `MISS_REFRESH_MIN_AGE_MS` is
 * trusted as-is — which is also what stops local/BYOK ids (never present in
 * CAPI, so permanently unresolvable) from causing repeated fetches.
 */
export function notifyUnknownModel(modelId: string): void {
  if (!refreshCtx || !modelId) return;
  const key = modelId.toLowerCase();
  if (notifiedUnknownIds.has(key)) return;
  notifiedUnknownIds.add(key);
  // Cold start has no snapshot to invalidate — `loadCatalog()` already refreshes.
  if (!cached) return;
  if (Date.now() - cached.fetchedAt < MISS_REFRESH_MIN_AGE_MS) return;
  refreshCtx.log(`modelCatalog: unresolved model "${key}" — forcing refresh`);
  runRefresh(refreshCtx.ctx, refreshCtx.log);
}

/**
 * Lookup helper used by the classifier. Returns `null` when the model is
 * not present in the catalog — callers should fall through to the existing
 * rate-table heuristic in that case.
 *
 * Precedence inside the catalog itself:
 *   1. CAPI `/models` entry exists with `billable: true` → BILLABLE.
 *      CAPI is GitHub's authoritative per-plan billing source. If it says
 *      a model id is billed on this plan, the presence of a BYOK alias
 *      with the same id (e.g. user has both Copilot Business AND a BYOK
 *      Anthropic key configured for `claude-opus-4.7`, or Copilot Chat
 *      itself registers Anthropic-backed models via
 *      `vscode.lm.selectChatModels()` with `vendor: "anthropic"`) is just
 *      a name collision — the model id alone can't tell us which path the
 *      request actually took, and the dashboard's traffic sources
 *      (chatSession logs, OMP/Pi sessions, Copilot CLI ledger) are all
 *      Copilot-routed by construction.
 *   2. User's `chatLanguageModels.json` / `vscode.lm` registry says this id
 *      belongs to a non-Copilot vendor → NON-BILLABLE. Only applied when
 *      step 1 didn't already mark it billable (so genuine Ollama / BYOK-only
 *      ids like `ollama/qwen2.5-coder:7b`, `local-llama-13b` still demote
 *      correctly).
 *   3. CAPI `/models` entry exists with `billable: false` → use that flag.
 *      (E.g. preview / utility models GitHub doesn't bill.)
 *
 * Background: without this precedence, every OMP / Pi session reported 0.00
 * AIC and the "non-billable" panel listed premium models like
 * `claude-opus-4.7`, `claude-sonnet-4.6`, `gpt-5.4` even though they are
 * GitHub-billed — because Copilot Chat's runtime registry surfaces its
 * Anthropic-backed routed models with `vendor: "anthropic"` and that landed
 * the same ids in `userVendorByModelId`, short-circuiting every traffic
 * source that lacked an explicit `copilotUsageNanoAiu` to non-billable.
 */
export function classifyByCatalog(modelName: string): ModelCatalogEntry | null {
  if (!cached) {
    return null;
  }
  const lower = modelName.toLowerCase();
  // OTel and CLI logs report ids with hyphens ("claude-haiku-4-5"); CAPI
  // publishes them with dots ("claude-haiku-4.5"). Try both forms.
  const normalized = lower.replace(/(\d)-(\d)/g, "$1.$2");

  const capiEntry =
    cached.byId.get(lower) ?? cached.byId.get(normalized) ?? null;

  const thirdPartyVendor =
    cached.userVendorByModelId.get(lower) ?? cached.userVendorByModelId.get(normalized);

  // 1. CAPI says billable → trust CAPI, ignore the BYOK alias collision.
  //    `userThirdParty` still rides along: when the same id is ALSO declared
  //    against the user's own key, the row is billable overall but individual
  //    requests may not be, and only per-request routing evidence can tell.
  if (capiEntry && capiEntry.billable) {
    return thirdPartyVendor ? { ...capiEntry, userThirdParty: true } : capiEntry;
  }

  // 2. No CAPI billable hit — fall back to the user/runtime third-party
  //    signal. This is where genuine Ollama / LM Studio / BYOK-only ids
  //    (which never appear in CAPI) correctly resolve to non-billable.
  if (thirdPartyVendor) {
    return {
      id: modelName,
      billable: false,
      vendor: thirdPartyVendor,
      userThirdParty: true,
      source: "user-config",
      // Only claim exclusivity when we actually hold a CAPI snapshot to
      // check against — an empty snapshot (offline / fetch failed) would
      // otherwise make every id look absent from Copilot's catalog.
      exclusiveThirdParty: cached.byId.size > 0 && !capiEntry,
    };
  }

  // 3. CAPI knows about it but billable=false (preview / utility).
  return capiEntry;
}

/**
 * Loads the catalog: hydrates from disk cache first (instant), then triggers
 * a background refresh if the cache is stale or empty. Designed to be called
 * once from `extension.activate()`.
 *
 * Network failures are swallowed — the classifier will simply not see this
 * source and fall back to the rate-table heuristic.
 */
export function loadCatalog(
  ctx: vscode.ExtensionContext,
  opts: { enabled: boolean; log: LogFn; refreshNow?: boolean }
): Promise<ModelCatalog | null> {
  // Honour the user-facing kill switch — `useOnlineModelCatalog === false`.
  if (!opts.enabled) {
    cached = null;
    refreshCtx = null;
    return Promise.resolve(null);
  }
  refreshCtx = { ctx, log: opts.log };

  // 1. Hydrate from disk cache so the classifier has something immediately.
  //    Rates come from the synced key (falling back to the pre-split payload
  //    on first run after upgrade); the vendor map is always machine-local.
  const local = ctx.globalState.get<CatalogCachePayload>(CATALOG_CACHE_KEY);
  const synced = ctx.globalState.get<SyncedCatalogPayload>(CATALOG_SYNC_KEY);
  const hasSynced = !!synced && Array.isArray(synced.entries) && synced.entries.length > 0;
  const hasLegacy = !!local && Array.isArray(local.entries) && local.entries.length > 0;
  const rates: SyncedCatalogPayload | undefined = hasSynced
    ? synced
    : hasLegacy
      ? { fetchedAt: local!.fetchedAt, entries: local!.entries!, cdnProviders: local!.cdnProviders ?? {} }
      : undefined;

  // A vendor map written by an older parser is missing ids this build can now
  // extract (BYOK `models[]`). Its existing entries stay valid — a v1 entry is
  // always a v2 entry — so hydrate it as-is for an instant answer, but refresh
  // regardless of TTL to pick up what it couldn't see.
  const vendorMapStale = (local?.vendorMapVersion ?? 1) !== VENDOR_MAP_VERSION;
  if (vendorMapStale) {
    opts.log(
      `modelCatalog: vendor map schema v${local?.vendorMapVersion ?? 1} < v${VENDOR_MAP_VERSION} — forcing refresh to re-parse chatLanguageModels.json`
    );
  }

  if (rates) {
    // A snapshot stamped in the future (clock skew across synced machines)
    // would read as permanently fresh, so treat it as expired instead.
    const fetchedAt = rates.fetchedAt > Date.now() ? 0 : rates.fetchedAt;
    cached = {
      fetchedAt,
      byId: new Map(rates.entries.map(e => [e.id.toLowerCase(), e])),
      cdnProviders: rates.cdnProviders ?? {},
      userVendorByModelId: new Map(local?.userVendorByModelId ?? []),
    };
    opts.log(
      `modelCatalog: hydrated ${cached.byId.size} entries from ${
        hasSynced ? "synced" : "legacy local"
      } cache (age=${Math.round((Date.now() - fetchedAt) / 60000)}min)`
    );
  }

  // 2. Decide whether to refresh from network.
  const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !opts.refreshNow && !vendorMapStale) {
    return Promise.resolve(cached);
  }

  // 3. Network refresh — fire and (mostly) forget. The first successful
  //    response replaces `cached` and is persisted.
  runRefresh(ctx, opts.log);

  return Promise.resolve(cached);
}

function runRefresh(ctx: vscode.ExtensionContext, log: LogFn): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  void refreshFromNetwork(ctx, log)
    .catch(err => log(`modelCatalog: refresh failed silently — ${String(err)}`))
    .finally(() => {
      refreshInFlight = false;
    });
}

// ─── Internal — network refresh ──────────────────────────────

async function refreshFromNetwork(ctx: vscode.ExtensionContext, log: LogFn): Promise<void> {
  // Fetch all four sources in parallel. Any may fail independently.
  //   • CDN manifest                — informational
  //   • CAPI /models                — authoritative GitHub billing
  //   • chatLanguageModels.json     — user's persisted third-party providers
  //   • vscode.lm.selectChatModels  — runtime BYOK / API-key providers
  const [cdnRes, capiRes, userRes, lmRes] = await Promise.allSettled([
    fetchCdnManifest(log),
    fetchCapiModels(log),
    readUserChatLanguageModels(ctx, log),
    readRegisteredLanguageModels(log),
  ]);

  const entries = new Map<string, ModelCatalogEntry>();
  const cdnProviders: Record<string, string[]> = {};

  // ── CDN manifest — INFORMATIONAL ONLY ───────────────────
  // Verified via tests/verify-online-catalog.ts: the manifest exposes only
  // BYOK provider keys (OpenAI, Anthropic, Gemini, Groq, xAI). The same
  // model id (e.g. `claude-opus-4-7`) appears in both this BYOK list and
  // the authoritative CAPI billable set, so we MUST NOT use the CDN data
  // to demote anything — we just record what providers know each id.
  if (cdnRes.status === "fulfilled" && cdnRes.value) {
    const manifest = cdnRes.value;
    for (const [provider, modelMap] of Object.entries(manifest.modelInfo ?? {})) {
      cdnProviders[provider] = Object.keys(modelMap ?? {});
    }
  }

  // ── Copilot CAPI /models — AUTHORITATIVE BILLING SOURCE ──────
  // Parsing is isolated: a schema change here must not discard the user's
  // third-party vendor map, which is parsed further down and is what BYOK
  // classification depends on.
  try {
    if (capiRes.status === "fulfilled" && capiRes.value) {
      let ratesParsed = 0;
      let billableCount = 0;
      let noRateSample: CapiModelResponse | null = null;
      for (const m of capiRes.value) {
        const rates = extractRatesFromCapi(m);
        if (rates) ratesParsed++;
        else if (!noRateSample && m.id !== "trajectory-compaction") noRateSample = m;
        // Billability now comes from rates (input_price > 0), because the
        // legacy `billing.multiplier` field was removed from CAPI.
        const billable = !!rates && rates.inputCreditsPerMillion > 0;
        if (billable) billableCount++;
        const cat = m.model_picker_price_category;
        entries.set(m.id.toLowerCase(), {
          id: m.id,
          billable,
          multiplier: rates ? Math.max(0.25, rates.inputCreditsPerMillion / 250) : undefined,
          isPremium: cat === "high" || cat === "very_high",
          preview: m.preview ?? false,
          vendor: m.vendor,
          rates,
          contextMax: extractContextMaxFromCapi(m),
          source: "capi",
        });
      }
      log(
        `modelCatalog: parsed per-1M rates for ${ratesParsed}/${capiRes.value.length} CAPI models (${billableCount} billable)`
      );
      if (ratesParsed === 0 && noRateSample) {
        // Fired when the response is missing token_prices entirely — usually
        // means CAPI is serving a legacy schema to our client headers. Dump
        // the whole sample: `billing` itself is one of the fields that went
        // missing, so it is not reliable to inspect on its own.
        let sample: string;
        try {
          sample = JSON.stringify(noRateSample) ?? String(noRateSample);
        } catch {
          sample = "<unserialisable>";
        }
        log(`modelCatalog: no-rates sample id=${noRateSample.id} raw=${sample.slice(0, 500)}`);
      }
    }
  } catch (err) {
    log(`modelCatalog: CAPI parse failed — ${String(err)} (continuing with other sources)`);
  }

  // ── User's chatLanguageModels.json + vscode.lm registry ─ THIRD-PARTY SIGNAL ──
  // Both sources tell us "which model id routes through which non-Copilot
  // vendor" — the file covers persisted UI choices (`vendor: "anthropic"`,
  // `vendor: "ollama"`, … i.e. API-key-based BYOK providers the user set up),
  // while the runtime registry covers anything Copilot Chat or other
  // extensions have actually registered with VS Code (catches BYOK ids that
  // never made it into the JSON file, plus Ollama-style dynamically-discovered
  // models). We merge them with a strict conflict rule: same id with the same
  // non-Copilot vendor in both → keep; different vendors → drop (be safe).
  const fileMap =
    userRes.status === "fulfilled" && userRes.value ? userRes.value : new Map<string, string>();
  const lmMap =
    lmRes.status === "fulfilled" && lmRes.value ? lmRes.value : new Map<string, string>();
  const userVendorByModelId = mergeThirdPartyMaps(fileMap, lmMap);

  if (
    entries.size === 0 &&
    Object.keys(cdnProviders).length === 0 &&
    userVendorByModelId.size === 0
  ) {
    log("modelCatalog: refresh produced 0 entries — keeping previous cache");
    return;
  }

  // CAPI occasionally serves the model list with the whole `billing` block
  // missing (observed: 40 models, 0 with rates). Persisting that would mark
  // every Copilot model non-billable and collapse all cost reporting, so keep
  // the rates we already have and take only the third-party map from this
  // round. A genuinely empty CAPI response is caught by the guard above.
  let effectiveEntries = entries;
  if (entries.size > 0 && ![...entries.values()].some(e => e.billable)) {
    const priorEntries = cached?.byId;
    if (priorEntries && [...priorEntries.values()].some(e => e.billable)) {
      log(
        `modelCatalog: CAPI returned ${entries.size} models with no rates — keeping ${priorEntries.size} previously-priced entries`
      );
      effectiveEntries = priorEntries;
    }
  }

  const next: ModelCatalog = {
    fetchedAt: Date.now(),
    byId: effectiveEntries,
    cdnProviders,
    userVendorByModelId,
  };
  cached = next;

  const entryList = Array.from(effectiveEntries.values());
  // Machine-local: only the vendor map. Rates live under the synced key so the
  // two are never duplicated and a synced snapshot can never carry a vendor
  // mapping from another machine.
  // Only claim the new schema when the config file was actually re-parsed —
  // otherwise an unreadable file would mark the map current and suppress the
  // forced refresh on every later activation.
  const payload: CatalogCachePayload = {
    fetchedAt: next.fetchedAt,
    vendorMapVersion:
      userRes.status === "fulfilled" && userRes.value ? VENDOR_MAP_VERSION : undefined,
    userVendorByModelId: Array.from(userVendorByModelId.entries()),
  };
  await ctx.globalState.update(CATALOG_CACHE_KEY, payload);
  await ctx.globalState.update(CATALOG_SYNC_KEY, {
    fetchedAt: next.fetchedAt,
    entries: entryList,
    cdnProviders,
  } satisfies SyncedCatalogPayload);

  const cdnTotal = Object.values(cdnProviders).reduce((s, ids) => s + ids.length, 0);
  log(
    `modelCatalog: refreshed — ${entries.size} CAPI billing entries, ${cdnTotal} CDN BYOK ids across ${Object.keys(cdnProviders).length} providers, ${userVendorByModelId.size} user-config third-party ids`
  );
}

async function fetchCdnManifest(log: LogFn): Promise<KnownModelsManifest | null> {
  try {
    const res = await fetch(KNOWN_MODELS_URL, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      log(`modelCatalog: CDN manifest returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as KnownModelsManifest;
    if (body.version !== 1 || typeof body.modelInfo !== "object" || body.modelInfo === null) {
      log("modelCatalog: CDN manifest has unexpected shape — ignoring");
      return null;
    }
    return body;
  } catch (err) {
    log(`modelCatalog: CDN fetch error — ${String(err)}`);
    return null;
  }
}

async function fetchCapiModels(log: LogFn): Promise<CapiModelResponse[] | null> {
  // 1. Borrow an existing VS Code GitHub session by walking the same scope
  //    candidates `planDetector.ts` uses. This means after the user has
  //    consented once (for plan detection, or because Copilot Chat itself
  //    minted a session), every subsequent refresh is silent — and it works
  //    regardless of which scope set the session was originally created with.
  let ghToken: string | undefined;
  for (const scopes of SCOPE_CANDIDATES) {
    try {
      const s = await vscode.authentication.getSession("github", scopes, {
        silent: true,
        createIfNone: false,
      });
      if (s) {
        ghToken = s.accessToken;
        log(`modelCatalog: silent GitHub session found with scopes=[${scopes.join(",")}]`);
        break;
      }
    } catch {
      /* fall through to next scope set */
    }
  }
  if (!ghToken) {
    log("modelCatalog: no silent GitHub session — skipping CAPI /models fetch");
    return null;
  }

  // 2. Mint a Copilot internal token and read endpoints.api from the
  //    response. The server returns the correct host for the user's plan
  //    (individual / business / enterprise) without us having to know it
  //    up front. Schema: `TokenEnvelope.endpoints.api` in
  //    microsoft/vscode-copilot-chat src/platform/authentication/common/copilotToken.ts.
  let copilotToken: string | undefined;
  let capiHost = FALLBACK_CAPI_HOST;
  try {
    const tokRes = await fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!tokRes.ok) {
      log(`modelCatalog: /copilot_internal/v2/token returned ${tokRes.status} — skipping CAPI`);
      return null;
    }
    const tokBody = (await tokRes.json()) as {
      token?: string;
      sku?: string;
      endpoints?: { api?: string };
    };
    copilotToken = tokBody.token;
    if (tokBody.endpoints?.api) {
      capiHost = tokBody.endpoints.api.replace(/\/+$/, "");
      log(`modelCatalog: token sku=${tokBody.sku ?? "?"} endpoints.api=${capiHost} (per-plan)`);
    } else {
      log(
        `modelCatalog: token response missing endpoints.api — falling back to ${FALLBACK_CAPI_HOST}`
      );
    }
  } catch (err) {
    log(`modelCatalog: token mint error — ${String(err)}`);
    return null;
  }
  if (!copilotToken) {
    return null;
  }

  // 3. GET ${endpoints.api}/models.
  try {
    const modelsUrl = `${capiHost}/models`;
    const modelsRes = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        // Modern client string — GitHub serves the current /models schema
        // (with `billing.token_prices.default.*_price`) only to recent
        // clients. Older Editor-Version values (< vscode/1.90) get a legacy
        // response missing the token_prices block.
        "Editor-Version": "vscode/1.95.0",
        "Editor-Plugin-Version": "copilot-chat/0.20.0",
        "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2025-04-01",
        "OpenAI-Intent": "model-access",
      },
    });
    if (!modelsRes.ok) {
      log(`modelCatalog: CAPI ${modelsUrl} returned ${modelsRes.status}`);
      return null;
    }
    const body = (await modelsRes.json()) as { data?: CapiModelResponse[] };
    if (!Array.isArray(body.data)) {
      log("modelCatalog: CAPI /models response missing .data array");
      return null;
    }
    return body.data;
  } catch (err) {
    log(`modelCatalog: CAPI fetch error — ${String(err)}`);
    return null;
  }
}

// ─── User-config — chatLanguageModels.json ────────────────────

/**
 * Read and parse the user's `<UserDir>/chatLanguageModels.json`. Returns
 * `null` (logged but non-fatal) if the file is missing, unreadable, or
 * malformed.
 *
 * The user dir is derived from `context.globalStorageUri` — which on every
 * platform and build (stable / Insiders / OSS / Remote / WSL) is
 * `<UserDir>/globalStorage/<extensionId>`. Going up two levels gives us the
 * User dir without any platform-specific path math.
 *
 * Parsing rules live in `chatLanguageModelsParser.ts` (pure function,
 * exercised directly from tests).
 */
async function readUserChatLanguageModels(
  ctx: vscode.ExtensionContext,
  log: LogFn
): Promise<Map<string, string> | null> {
  try {
    const userDir = vscode.Uri.joinPath(ctx.globalStorageUri, "..", "..");
    const fileUri = vscode.Uri.joinPath(userDir, "chatLanguageModels.json");
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder("utf-8").decode(bytes);
    const map = parseUserChatLanguageModels(text);
    log(
      `modelCatalog: chatLanguageModels.json → ${map.size} unambiguous third-party model ids`
    );
    return map;
  } catch (err) {
    // ENOENT / FileNotFound is the common case for users who have never
    // configured a third-party chat provider — log at info level and move on.
    log(`modelCatalog: chatLanguageModels.json not readable — ${String(err)}`);
    return null;
  }
}

// ─── Runtime — vscode.lm.selectChatModels() ──────────────────

/**
 * Enumerate every chat model currently registered with VS Code and return
 * a `lowercase id → vendor` map for **unambiguous non-Copilot** entries.
 *
 * This is the runtime complement to `readUserChatLanguageModels()`. The
 * file-based reader knows about ids the user has *typed into* settings;
 * this reader knows about everything Copilot Chat / other extensions have
 * actually registered as a chat model — including:
 *
 *  • BYOK API-key providers (Anthropic, OpenAI, Gemini, Groq, xAI) once
 *    the user has stored their key — Copilot Chat registers the resulting
 *    model with its own vendor tag (e.g. `vendor: "anthropic"`), so we
 *    can tell it apart from native GitHub-billed Copilot models.
 *  • Ollama / LM Studio models discovered dynamically at runtime, which
 *    typically don't appear in `chatLanguageModels.json` because the file
 *    only persists explicit settings overrides.
 *  • Any other vendor an extension contributes via VS Code's chat API.
 *
 * `vscode.lm.selectChatModels()` is enumeration-only — the consent
 * dialog is reserved for `LanguageModelChat.sendRequest()`, so calling
 * this during refresh is safe and silent. Failures (older VS Code, no
 * API, etc.) are swallowed and an empty map is returned.
 */
async function readRegisteredLanguageModels(log: LogFn): Promise<Map<string, string>> {
  try {
    const models = await vscode.lm.selectChatModels();
    // Bucket by lowercase id to detect ambiguity within this source.
    const idToVendors = new Map<string, Set<string>>();
    for (const m of models) {
      const id = (m.id ?? "").toLowerCase();
      const vendor = (m.vendor ?? "").toLowerCase();
      if (!id || !vendor) {
        continue;
      }
      const set = idToVendors.get(id) ?? new Set<string>();
      set.add(vendor);
      idToVendors.set(id, set);
    }

    const out = new Map<string, string>();
    for (const [id, vendors] of idToVendors) {
      if (vendors.size !== 1) {
        continue; // ambiguous within the runtime registry
      }
      const [v] = vendors;
      if (v === "copilot") {
        continue; // billable
      }
      out.set(id, v);
    }
    log(
      `modelCatalog: vscode.lm.selectChatModels → ${out.size} non-copilot model ids (from ${models.length} registered)`
    );
    return out;
  } catch (err) {
    log(`modelCatalog: vscode.lm.selectChatModels unavailable — ${String(err)}`);
    return new Map<string, string>();
  }
}