/**
 * verify-catalog-miss-refresh.js
 *
 * The model catalog is cached in globalState and only re-fetched once per 24h,
 * so a model GitHub ships at 14:00 stays unknown until the next day if the
 * snapshot happened to refresh at 09:00 — it is "fresh" and nothing forces it
 * to look again. That window is exactly when `findModelRate()` mispriced
 * `claude-opus-5` and classified it as non-billable.
 *
 * `notifyUnknownModel()` closes it: an id that neither the snapshot nor the
 * static table can resolve is direct evidence the snapshot is behind, so it
 * forces an out-of-band refresh. This pins the debounce rules that keep that
 * from turning into a fetch storm for local/BYOK ids, which never resolve.
 *
 * Run after compile:
 *   node tests/verify-catalog-miss-refresh.js
 */

const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

// The shared stub covers only what the rate-table tests need. The catalog
// refresh path also touches auth and the chat-models API; both must merely
// exist and reject, since every source is best-effort.
const vscodeStub = require(stubPath);
vscodeStub.authentication = { getSession: async () => undefined };
vscodeStub.lm = { selectChatModels: async () => [] };

// Count refresh attempts without touching the network.
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  throw new Error("network disabled in test");
};

const { loadCatalog, notifyUnknownModel } = require(path.join(OUT, "modelCatalog.js"));

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ""}`);
    failed++;
  }
}

const MINUTE = 60 * 1000;

/** Fake ExtensionContext serving a snapshot of the given age. */
function ctxWithSnapshotAge(ageMs) {
  const payload = {
    fetchedAt: Date.now() - ageMs,
    entries: [
      {
        id: "gpt-4.1",
        isPremium: false,
        rates: {
          inputCreditsPerMillion: 200,
          outputCreditsPerMillion: 800,
          cachedInputCreditsPerMillion: 20,
          cacheWriteCreditsPerMillion: 0,
        },
      },
    ],
    cdnProviders: {},
    userVendorByModelId: [],
    // Current schema — otherwise the upgrade path forces a refresh and these
    // cases can't isolate TTL/miss behaviour.
    vendorMapVersion: 2,
  };
  return { globalState: { get: () => payload, update: async () => {} } };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

async function main() {
  console.log("== Test 1: a miss before the catalog loads is a no-op ==");
  notifyUnknownModel("never-seen-0");
  await settle();
  ok("no refresh without an ExtensionContext", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

  console.log("\n== Test 2: loading a fresh snapshot does not refresh ==");
  await loadCatalog(ctxWithSnapshotAge(2 * MINUTE), { enabled: true, log: () => {} });
  await settle();
  ok("fresh cache short-circuits the TTL refresh", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

  console.log("\n== Test 3: a miss against a just-refreshed snapshot is trusted ==");
  notifyUnknownModel("ollama/qwen2.5-coder:7b");
  await settle();
  ok(
    "unresolvable local id does not force a refetch",
    fetchCalls === 0,
    `fetchCalls=${fetchCalls}`
  );

  console.log("\n== Test 4: a miss against an older snapshot forces a refresh ==");
  await loadCatalog(ctxWithSnapshotAge(20 * MINUTE), { enabled: true, log: () => {} });
  await settle();
  ok("re-hydrating a 20min snapshot still skips the TTL refresh", fetchCalls === 0);

  notifyUnknownModel("claude-opus-9");
  await settle();
  const afterFirstMiss = fetchCalls;
  ok("unknown model forces an out-of-band refresh", afterFirstMiss > 0, `fetchCalls=${fetchCalls}`);

  console.log("\n== Test 5: the same id never forces a second refresh ==");
  notifyUnknownModel("claude-opus-9");
  await settle();
  ok(
    "repeat miss is deduplicated",
    fetchCalls === afterFirstMiss,
    `${fetchCalls} vs ${afterFirstMiss}`
  );

  console.log("\n== Test 6: a failed refresh keeps the previous snapshot ==");
  const { getRatesFor } = require(path.join(OUT, "modelCatalog.js"));
  const gpt41 = getRatesFor("gpt-4.1");
  ok(
    "cached rates survive the failed fetch",
    gpt41 && gpt41.inputCreditsPerMillion === 200,
    JSON.stringify(gpt41)
  );

  console.log("\n== Test 7: the kill switch disables miss-driven refreshes ==");
  await loadCatalog(ctxWithSnapshotAge(20 * MINUTE), { enabled: false, log: () => {} });
  const beforeDisabled = fetchCalls;
  notifyUnknownModel("claude-opus-11");
  await settle();
  ok(
    "no refresh when useOnlineModelCatalog is off",
    fetchCalls === beforeDisabled,
    `${fetchCalls} vs ${beforeDisabled}`
  );

  console.log("");
  if (failed > 0) {
    console.log(`${failed} catalog miss-refresh check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All catalog miss-refresh checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
