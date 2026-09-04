/**
 * verify-recorded-vendor-split.js
 *
 * VS Code stamps the dispatching vendor on every request's `modelId`
 * (`copilot/claude-opus-5` vs `customendpoint/Azure OAI/claude-opus-5`).
 * That is observed routing, so an id sold by BOTH Copilot and a BYOK key
 * must split on it WITHOUT any help from the model catalog — which is what
 * previously failed and billed Azure-served traffic as Copilot premium.
 */
const path = require("path");
const Module = require("module");
const stub = path.resolve(__dirname, "_vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  return req === "vscode" ? stub : orig.call(this, req, ...rest);
};

const {
  createCalculatorFromConfig,
  DEFAULT_AIC_CONFIG,
  classifyModelBillability,
  isCopilotVendor,
} = require("../out/aicCredits.js");
const { splitModelIdentifier, providerLabel } = require("../out/scanner.js");

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; }
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    console.log(`         expected ${JSON.stringify(expected)}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
  }
}

console.log("\n1. splitModelIdentifier");
check("copilot-routed id", splitModelIdentifier("copilot/claude-opus-5"), {
  model: "claude-opus-5", vendor: "copilot", provider: "",
});
check("BYOK id keeps the provider display name",
  splitModelIdentifier("customendpoint/Azure Foundry Anthropic/claude-opus-5"), {
    model: "claude-opus-5", vendor: "customendpoint", provider: "Azure Foundry Anthropic",
  });
check("legacy bare id yields no vendor", splitModelIdentifier("claude-opus-5"), {
  model: "claude-opus-5", vendor: "", provider: "",
});
check("empty id is safe", splitModelIdentifier(""), { model: "", vendor: "", provider: "" });

console.log("\n2. isCopilotVendor");
check("copilot", isCopilotVendor("copilot"), true);
check("case/space insensitive", isCopilotVendor("  Copilot "), true);
check("customendpoint", isCopilotVendor("customendpoint"), false);
check("empty is not a claim", isCopilotVendor(""), false);

console.log("\n2b. providerLabel — `customendpoint` is a mechanism, not a name");
check("prefers the name the user gave the provider",
  providerLabel("customendpoint", "Azure Foundry Anthropic"), "Azure Foundry Anthropic");
check("falls back to the vendor only when no name was recorded",
  providerLabel("customendpoint", ""), "customendpoint");
check("a whitespace-only name is not a name",
  providerLabel("customendpoint", "   "), "customendpoint");
check("self-describing vendors are already readable",
  providerLabel("ollama", ""), "ollama");

console.log("\n3. classification — recorded vendor, catalog deliberately empty");
const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const noCatalog = () => null;
const classify = (model, hasActual, hint, vendor) =>
  classifyModelBillability(calc, DEFAULT_AIC_CONFIG, model, hasActual, noCatalog, hint, vendor);

// The exact regression: same id, two routes, no catalog to disambiguate.
check("Azure-routed claude-opus-5 is NOT billable",
  classify("claude-opus-5", false, "copilotLanguageModelWrapper", "customendpoint"), false);
check("Copilot-routed claude-opus-5 IS billable",
  classify("claude-opus-5", false, "panel/editAgent", "copilot"), true);
check("a real credit figure still wins over the vendor",
  classify("claude-opus-5", true, "copilotLanguageModelWrapper", "customendpoint"), true);
check("any non-Copilot vendor demotes",
  classify("qwen3", false, undefined, "ollama"), false);

console.log("\n4. no recorded vendor — legacy behaviour must be untouched");
check("bare known Copilot model stays billable",
  classify("claude-opus-5", false, undefined, undefined), true);
check("empty vendor string is not treated as a claim",
  classify("claude-opus-5", false, "panel/editAgent", ""), true);

console.log("\n4b. a subagent on a BYOK provider keeps the provider's vendor");
// Real shape: the user picked claude-sonnet-5 from an Azure endpoint, and a
// subagent inside the turn ran claude-opus-5 on that same endpoint. Matching
// the turn's model is the usual proof of ownership, but it rejects this case —
// the wrapper debugName is what proves the request never touched Copilot.
check("wrapper-dispatched call on a different model is NOT billable",
  classify("claude-opus-5", false, "copilotLanguageModelWrapper", "customendpoint"), false);
check("a Copilot-routed auxiliary call is still billable",
  classify("claude-haiku-4.5", false, "tool/runSubagent-Explore", "copilot"), true);
check("summarisation on Copilot's route stays billable",
  classify("claude-sonnet-5", false, "summarizeConversationHistory", "copilot"), true);

console.log("\n5. user config still outranks recorded vendor");
const excluded = { ...DEFAULT_AIC_CONFIG, excludeModels: ["claude-opus-5"] };
check("excludeModels beats a copilot vendor",
  classifyModelBillability(calc, excluded, "claude-opus-5", false, noCatalog, undefined, "copilot"),
  false);
const forced = { ...DEFAULT_AIC_CONFIG, extraBilledModels: ["claude-opus-5"] };
check("extraBilledModels beats a BYOK vendor",
  classifyModelBillability(calc, forced, "claude-opus-5", false, noCatalog, undefined, "customendpoint"),
  true);

console.log(
  failures === 0
    ? "\nAll recorded-vendor checks passed.\n"
    : `\n${failures} check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
