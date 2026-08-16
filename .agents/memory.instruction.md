---
applyTo: '**'
---

# Coding Preferences
- No package installation in this repo; use existing dependencies only.
- On Windows, invoke tool entrypoints directly with `C:\nodejs\node.exe` instead of `node_modules/.bin` shell wrappers when needed.

# Project Architecture
- VS Code extension in TypeScript with source under `src/`.
- `src/scanner.ts` parses workspaceStorage chat sessions and debug logs.
- `src/otelReceiver.ts` hosts a local OTLP HTTP receiver and aggregates live stats.
- `src/dashboardData.ts` computes dashboard aggregates; `src/dashboardPanel.ts` renders the webview UI.

# Solutions Repository
- Repository currently has a single git commit baseline plus local uncommitted edits.
- `C:\nodejs\node.exe node_modules\typescript\bin\tsc -p ./` compiles cleanly in this workspace.
- `C:\nodejs\node.exe node_modules\eslint\bin\eslint.js src/**/*.ts` is the Windows-safe lint entrypoint; `node_modules\.bin\eslint` is a POSIX shim here.
- Status-bar `MarkdownString` layout must use native Markdown tables; sanitizer-sensitive width/flex CSS is unreliable. Multi-column label/value pairs prevent intrinsic-width collapse without fixed dimensions.
- The webview script in `dashboardPanel.ts` lives inside a TS template literal — never use backticks in its comments or code; it breaks compilation.
- Dashboard historical ranges (any month outside the current billing cycle) are rendered from `SessionView.aicCredits`, NOT `aicSummary.byDay` (which `computeSummary` clips to the cycle). Gating that field by date silently zeroes whole months.
- `tests/verify-sidebar-dashboard-parity.js` has a pre-existing failing assertion (`byModel.length ≤ 5`) on `main`; ignore it when checking regressions. `verify-no-drift.js`, `verify-dashboard-vs-api.js` and `verify-live-aic-reconciliation.js` (missing vscode stub) also fail on `main`.
- There is exactly ONE credit basis: the `creditEntries` list in `buildDashboardData`. `aicSummary.byDay`, `SessionView.aicByDay` and `aicSummary.unattributedByDay` are all derived from it. Never add a second pass over `scan.turns` to compute credits — that is what caused the Usage-by-Model vs hero drift.
- Range-filter session credits on `SessionView.aicByDay`, never by testing `lastDate` against the range. Sessions routinely span month/cycle boundaries.
- OMP/Pi write sessions both as `<sessionsRoot>/<project>/*.jsonl` AND loose `<sessionsRoot>/*.jsonl`. `scanDirectory` must read both.
- Agent `usage.cost.total` is populated on only ~13% of messages. Never gate on a summed `costCredits > 0` — price the recorded calls from the ledger and rate-estimate the `unpriced` bucket separately (Copilot-routed only).
- Register `copilotUsage.panel`'s WebviewViewProvider synchronously at the top of `activate()`. VS Code resolves a pinned `type: "webview"` view at window load; a provider registered after an `await` leaves the panel blank for the whole session.
- `activate()` MUST `await runScan()`. Fire-and-forget renders a dashboard of zeros — rejected in v1.9.14 and again in 1.10.95. If the scan is slow, fix the scan (persistent mtime cache), not the await.
- `chatSessions/*.jsonl` has TWO shapes: legacy (`kind=0` header + `v.requests[]`) and current (header-less delta log; `kind=1` sets at a path, `kind=2` appends; session id only in the filename). `parseSessionContent` must handle both — replay capture runs before the legacy branches because those `continue`.
- A silent `canonicalSessions: 0` with `sourceFiles: N > 0` means the session parser returned null, not that data is missing. Check the file shape first.
- Never delete build artifacts. Every `.vsix` back to 1.10.27 is kept in the repo root on purpose.
- Extension host log: `%APPDATA%\Code\logs\<ts>\window<N>\exthost\exthost.log`; our output channel: `.../output_logging_<ts>/N-Copilot Usage.log`. A 0-byte channel log means activation never got past `createOutputChannel`.
- The dashboard's agent columns count only `github-copilot`-provider traffic; `azure-*` / third-party providers are classified non-billable by design (Azure bills them), so they will always read lower than the agent's own usage tool.