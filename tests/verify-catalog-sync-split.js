/**
 * Verifies the model-catalog sync split (issue: cross-machine catalog sync).
 *
 * Guarantees:
 *   1. The account-scoped key is declared to Settings Sync, and it is the ONLY
 *      key declared — the machine-local key must never leave this machine.
 *   2. A synced snapshot from another machine supplies the rates.
 *   3. That snapshot can NOT overwrite this machine's `userVendorByModelId`,
 *      which is what would otherwise flip rows between billable and
 *      non-billable after a sync.
 *   4. Pre-split payloads (rates stored under the local key) still hydrate.
 *   5. A future-dated `fetchedAt` (clock skew between machines) is treated as
 *      expired rather than permanently fresh.
 */
const path = require("path");
const Module = require("module");

const stub = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return stub;
  return origResolve.call(this, request, ...rest);
};

const catalog = require(path.join(__dirname, "..", "out", "modelCatalog.js"));

const LOCAL_KEY = "copilotUsage.aic.modelCatalog.v1";
const SYNC_KEY = "copilotUsage.aic.modelCatalogRates.v1";

function makeCtx(seed) {
  const store = new Map(Object.entries(seed || {}));
  const syncKeys = [];
  return {
    syncKeys,
    globalState: {
      get: (k) => store.get(k),
      update: async (k, v) => { store.set(k, v); },
      setKeysForSync: (keys) => { syncKeys.length = 0; syncKeys.push(...keys); },
    },
  };
}

const entry = (id) => ({
  id,
  billable: true,
  vendor: "copilot",
  source: "capi",
  rates: { input: 1, output: 2, cached: 0 },
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const log = () => {};
const now = Date.now();

// ── 1 + 2 + 3: synced rates arrive, local vendor map survives ────────────
{
  const ctx = makeCtx({
    [LOCAL_KEY]: {
      fetchedAt: now - 1000,
      // This machine has Ollama configured; the other machine does not.
      userVendorByModelId: [["llama3", "ollama"]],
    },
    [SYNC_KEY]: {
      fetchedAt: now - 1000,
      entries: [entry("gpt-5"), entry("claude-opus-4.7")],
      cdnProviders: { anthropic: ["claude-opus-4.7"] },
    },
  });

  catalog.loadCatalog(ctx, { enabled: true, log });

  // Key registration moved to machineSync.registerSyncKeys(): setKeysForSync
  // replaces the whole declared list rather than appending, so it must have a
  // single caller. loadCatalog must therefore NOT declare anything itself.
  check("loadCatalog no longer declares sync keys itself",
    ctx.syncKeys.length === 0,
    JSON.stringify(ctx.syncKeys));

  check("machine-local key is NOT synced",
    !ctx.syncKeys.includes(LOCAL_KEY));

  const rate = catalog.classifyByCatalog("gpt-5");
  check("synced snapshot supplies the rate card", !!rate, JSON.stringify(rate));

  const vendorHit = catalog.classifyByCatalog("llama3");
  check("local vendor map survives the synced snapshot",
    !!vendorHit && vendorHit.billable === false && vendorHit.vendor === "ollama",
    JSON.stringify(vendorHit));
}

// ── 3b: a synced payload carrying a vendor map must be ignored ───────────
{
  const ctx = makeCtx({
    [LOCAL_KEY]: { fetchedAt: now - 1000, userVendorByModelId: [] },
    [SYNC_KEY]: {
      fetchedAt: now - 1000,
      entries: [entry("gpt-5")],
      cdnProviders: {},
      // Hostile/legacy field — another machine's Ollama registration.
      userVendorByModelId: [["gpt-5", "ollama"]],
    },
  });

  catalog.loadCatalog(ctx, { enabled: true, log });
  const hit = catalog.classifyByCatalog("gpt-5");
  check("vendor map inside a synced payload is ignored",
    !!hit && hit.billable === true,
    JSON.stringify(hit));
}

// ── 4: pre-split payload still hydrates ──────────────────────────────────
{
  const ctx = makeCtx({
    [LOCAL_KEY]: {
      fetchedAt: now - 1000,
      entries: [entry("gpt-4.1")],
      cdnProviders: {},
      userVendorByModelId: [["mistral", "lmstudio"]],
    },
  });

  catalog.loadCatalog(ctx, { enabled: true, log });
  check("pre-split local payload still hydrates rates",
    !!catalog.classifyByCatalog("gpt-4.1"));
  const legacyVendor = catalog.classifyByCatalog("mistral");
  check("pre-split local payload still hydrates vendor map",
    !!legacyVendor && legacyVendor.billable === false,
    JSON.stringify(legacyVendor));
}

// ── 5: clock skew is not treated as freshness ────────────────────────────
{
  const ctx = makeCtx({
    [LOCAL_KEY]: { fetchedAt: now, userVendorByModelId: [] },
    [SYNC_KEY]: {
      // Two days ahead — another machine's clock is wrong.
      fetchedAt: now + 2 * 24 * 60 * 60 * 1000,
      entries: [entry("gpt-5")],
      cdnProviders: {},
    },
  });

  let refreshed = false;
  const origFetch = global.fetch;
  global.fetch = async () => { refreshed = true; throw new Error("offline"); };
  try {
    catalog.loadCatalog(ctx, { enabled: true, log });
  } finally {
    global.fetch = origFetch;
  }
  check("future-dated snapshot does not suppress refresh", refreshed);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
