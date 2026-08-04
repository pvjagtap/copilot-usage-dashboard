// Measures the real catalog payload against VS Code's sync thresholds.
// Read-only against the live globalStorage DB.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const dbPath = path.join(process.env.APPDATA, "Code", "User", "globalStorage", "state.vscdb");
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("pvjagtap.copilot-usage-dashboard");

if (!row) {
  console.log("no extension state row found");
  process.exit(0);
}

const state = JSON.parse(row.value);
const legacy = state["copilotUsage.aic.modelCatalog.v1"];
const synced = state["copilotUsage.aic.modelCatalogRates.v1"];
const src = synced || legacy;

if (!src) {
  console.log("no catalog key present; keys =", Object.keys(state).join(", "));
  process.exit(0);
}

const rates = { fetchedAt: src.fetchedAt, entries: src.entries || [], cdnProviders: src.cdnProviders || {} };
const bytes = Buffer.byteLength(JSON.stringify(rates));
const WARN = 512 * 1024;

console.log("source key         :", synced ? "synced" : "legacy local");
console.log("catalog entries    :", rates.entries.length);
console.log("vendor map entries :", (legacy?.userVendorByModelId || []).length);
console.log("synced payload     :", bytes, "bytes (" + (bytes / 1024).toFixed(1) + " KB)");
console.log("VS Code warn @     :", WARN, "bytes (512.0 KB)");
console.log("headroom           :", ((1 - bytes / WARN) * 100).toFixed(1) + "%");
console.log("total ext state    :", Buffer.byteLength(row.value), "bytes");
