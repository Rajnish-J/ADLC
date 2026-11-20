# SDLC Agent Governance — VS Code Extension

A standalone VS Code extension (the **client**) plus a companion **host/runtime** that governs AI agents across the software development lifecycle: discovery of on-disk agent/skill manifests, enforcing evaluation gates, governed orchestration, and end-to-end audit — built over Azure AI Foundry.

This repository began as the **Phase 1** deliverable and now also contains the later phases (discovery, evaluation + gate, orchestration runtime, visual builder). The roadmap and how far each phase has got are in [`SDLC_WORKFLOW_ORCHESTRATION.md`](../../SDLC_WORKFLOW_ORCHESTRATION.md); this README's setup and verification steps still centre on Phase 1. It is a self-contained npm project that does **not** depend on the parent analytics app; it **harvests pure logic** from that app's `orka` feature (Foundry connection shape, scopes, API versions, token cache) per §3.5 of `SDLC_WORKFLOW_ORCHESTRATION.md`.

## Phase 1 scope

| Capability | Where |
|---|---|
| Extension scaffold + activation + sidebar (Stories / Agents / Workflows sections) | `src/extension.ts`, `src/views/sectionedTreeProvider.ts` |
| Azure sign-in (VS Code Microsoft provider) | `src/auth/azureAuth.ts` |
| ClientSecretCredential fallback (headless/CI) | `src/auth/clientSecretFallback.ts`, `src/auth/tokenCache.ts` |
| SecretStorage round-trip | `src/secrets/secretStore.ts` |
| Foundry connection + project list (the spike) | `src/foundry/*`, `src/views/foundryProjectsProvider.ts` |

See [`PHASE_1_TASKS.md`](../../PHASE_1_TASKS.md) for the task breakdown, [`BUILD_VS_BUY.md`](../../BUILD_VS_BUY.md) for the Foundry Toolkit build-vs-buy matrix (T5), and [`docs/adr/0001-phase-1-foundations.md`](../../docs/adr/0001-phase-1-foundations.md) for the decision record.

## Stack

- **Language:** TypeScript (strict, no `any`)
- **Build:** esbuild → `dist/extension.js`; packaged with `@vscode/vsce`
- **Auth:** VS Code built-in `microsoft` authentication provider (primary); `ClientSecretCredential` (`@azure/identity`, optional dep) as the headless fallback
- **Foundry API:** new projects API; versions ARM `2022-12-01`, Cognitive `2025-06-01`, Foundry data `2025-05-01`
- **Orchestration framework (MAF):** deferred to Phase 4

## Prerequisites

- **Node.js ≥ 18** and npm (verified on Node 22 / npm 11)
- **VS Code ≥ 1.90**
- For the live sign-in / Foundry checks only: an Azure work account with access to an Azure AI Foundry (AIServices) resource

## 1. Install

```bash
cd sdlc-governance-extension
npm install
```

Installs all dev dependencies (TypeScript, esbuild, ESLint, vsce, and the `@vscode/test-*` test tooling). `@azure/identity` is an **optional** dependency used only by the headless `ClientSecretCredential` fallback.

## 2. Check it all works (command line)

Run these from the `sdlc-governance-extension/` folder. Each is independent; run them in order for a full gate.

| Step | Command | Pass looks like |
|------|---------|-----------------|
| Type safety (strict, no `any`) | `npm run typecheck` | no output, exit 0 |
| Lint | `npm run lint` | no output, exit 0 |
| Build (esbuild bundle) | `npm run build` | `dist\extension.js  8.0kb` … `build complete` |
| Package (VSIX) | `npm run package` | `Packaged: …sdlc-governance-extension-<version>.vsix` |
| **Run in real VS Code** | `npm test` | `6 passing` … `Exit code: 0` |

One-liner for the first four (PowerShell):

```powershell
npm run typecheck; if ($?) { npm run lint }; if ($?) { npm run build }; if ($?) { npm run package }
```

### About `npm test` (integration tests)

`npm test` downloads a real VS Code build (~243 MB, first run only), loads this extension into it, and runs every `*.test.js` under `out/test` — the Phase 1 activation suite plus the discovery, evaluation, runtime, audit, telemetry and `SecretStore` suites. The activation suite asserts the extension activates, registers its commands (see `EXPECTED_COMMANDS` in [`src/test/extension.test.ts`](./src/test/extension.test.ts)), contributes its views, and runs no-auth commands without error. The total count grows as suites are added (204 passing on 2026-10-30), so check for **0 failing** rather than a fixed number. Expected output (activation and T3 suites shown):

```
SDLC Governance — Phase 1 activation
  √ extension is present
  √ extension activates
  √ all commands are registered
  √ view container and views are contributed
  √ Discover command runs without throwing (empty/no workspace is fine)
  √ Show Status command runs without throwing (no auth required)
  √ Refresh Foundry Projects command runs without throwing
  √ Open Evaluation Results command runs without throwing (no runs yet)
T3 — SecretStore round-trip
  √ connection metadata round-trips identically
  √ client-secret fallback credentials round-trip identically
  √ App Insights connection string round-trips and is readable through get()
  √ malformed stored JSON reads back as undefined instead of throwing
  √ clear() removes every key the wrapper owns
  √ onDidChange fires for writes and for clear()
…
204 passing
```

The `SecretStore` tests use an in-memory `SecretStorage`; surviving a real Extension Host reload still needs the OS keychain and is checked by hand in section 3.

The custom launcher ([`src/test/runTest.ts`](./src/test/runTest.ts)) transparently handles two Windows hazards, so `npm test` works in-place — no copying required:

- **`ELECTRON_RUN_AS_NODE`** — VS Code's integrated terminal exports this; if inherited, the spawned `Code.exe` boots as plain Node and rejects every flag (`bad option: --no-sandbox`). The launcher clears it.
- **Spaces in the project path** (e.g. `…\Ofc Projects\…`) — `@vscode/test-electron` spawns with `shell:true` and doesn't quote arg values, so a spaced path gets word-split. The launcher exposes the project via a space-free directory **junction** (no admin, no copy) and uses a space-free temp profile dir. Both shims are Windows-only and only activate when the path contains a space — a no-op on clean paths and CI.

## 3. Run it interactively (Extension Development Host)

The live Azure sign-in (T2) and Foundry project list (T4) need an interactive login, so verify them by hand:

1. Open **this folder** as its own VS Code window (`File → Open Folder → sdlc-governance-extension`). Open the folder directly — F5 launches whatever folder is open.
2. Press **F5** (Run → Start Debugging). This starts esbuild in watch mode and opens a second **[Extension Development Host]** window.
3. In that window, verify:

| Action | Expected result | Task |
|--------|-----------------|------|
| Look at the Activity Bar | A shield **"SDLC Governance"** icon → Stories, Agents and Workflows views (Foundry projects under Agents › Azure AI Foundry) | T1 |
| Command Palette → **SDLC Governance: Show Status** | Toast: *"Phase 1 active. Signed-in account: none"* | T1 |
| Click status bar `🛡 SDLC: sign in` (or run **Sign in to Azure**) | Microsoft sign-in; then *"Signed in as <you>"* and status bar updates | T2 |
| Open **Agents › Azure AI Foundry › Projects** (or click ↻) | Live, RBAC-scoped list of your Foundry projects; expand for account/RG/endpoint | T4 |
| Run **Clear Stored Connection**, then `Ctrl+R` to reload | State clears and resurvives reload cleanly | T3 |

To debug: in the **main** window open the **Debug Console** for extension output; in the **dev host** use *Developer: Toggle Developer Tools* → Console for runtime errors.

> If sign-in works but Foundry Projects shows an error row, it's almost always Azure RBAC (your account lacks **Foundry User**/reader on an AIServices resource) — the node text says which call failed (tokens are auto-redacted). That's a permissions result, not a code bug.

## NPM scripts reference

| Script | Does |
|--------|------|
| `npm run watch` | esbuild in watch mode (used by F5) |
| `npm run build` | production esbuild bundle → `dist/extension.js` |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint over `src` |
| `npm run compile-tests` | compile integration tests → `out/` (via `tsconfig.test.json`) |
| `npm test` | build + compile-tests + run in a real VS Code (`@vscode/test-cli`) |
| `npm run package` | emit the installable `.vsix` (`@vscode/vsce`) |

### Commands contributed (Command Palette)

- **SDLC Governance: Show Status** — confirms activation and shows the signed-in account
- **SDLC Governance: Sign in to Azure** — interactive Microsoft sign-in (ARM + Foundry scopes)
- **SDLC Governance: Sign out of Azure** — guidance to remove the session
- **SDLC Governance: Refresh Foundry Projects** — reloads the RBAC-scoped project list
- **SDLC Governance: Clear Stored Connection** — wipes SecretStorage state

## Workflow runtime engine and gates

Workflows run on one of two engines, chosen by `sdlcGovernance.runtime.engine` (reload the window after
changing it):

- **`langgraph`** (default) — a real `@langchain/langgraph` state graph (see
  [`docs/adr/0003-langgraph-orchestration-engine.md`](../../docs/adr/0003-langgraph-orchestration-engine.md)).
  Progress streams to the canvas node by node. Runs are checkpointed under the extension's global storage, so a
  run paused on a plan approval is **restored after a window reload**; a run interrupted mid-step is shown once
  as failed; finished and cancelled runs are deleted from the store; paused runs older than 14 days are dropped.
  Cancel aborts the in-flight model request.
- **`interpreter`** — the original in-memory engine (no durable store). Fallback only.

The check after each agent step is controlled by `sdlcGovernance.gate.evaluator`: `auto` (default) enforces
gates with Foundry evaluators when you are signed in and `gate.projectEndpoint` is set and otherwise falls back
to the offline stub — loudly, with every stub verdict labelled; `foundry` always uses Foundry; `stub` is for
demos. Full behaviour, including which evaluators an in-run gate cannot run, is in
[`USAGE.md`](../../USAGE.md) §9.4. The live-Foundry path can only be verified against a real project and judge
deployment; the offline suites prove the decision logic and wiring.

## What's NOT in Phase 1

Discovery/normalization engine (Phase 2), evaluation + enforcing gate (Phase 3), orchestration runtime + master orchestrator (Phase 4), visual builder + control plane (Phase 5), and the microVM sandbox (parked). See the root `SDLC_WORKFLOW_ORCHESTRATION.md`.
