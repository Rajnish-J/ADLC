# ADR 0001 — Phase 1 Foundations

- **Status:** Accepted (Phase 1)
- **Date:** 2026-06-02
- **Context source:** `SDLC_WORKFLOW_ORCHESTRATION.md` §3 Phase 1, §7 Open decisions

## Context

Phase 1 of the SDLC Agent Governance Platform stands up a loadable VS Code extension with real Azure auth and a Foundry connection spike. Several choices here are hard to reverse, so we record them before writing feature code. Where a decision is genuinely deferred (it belongs to a later phase), we say so explicitly rather than locking it prematurely.

## Decisions

### 1. Extension stack — TypeScript + esbuild + `@vscode/vsce`
**Decision:** Build the client in TypeScript, bundle with esbuild, package with `@vscode/vsce`.
**Why:** Current VS Code extension best practice; fast bundling and lean VSIX. ESLint enforces the no-`any` project rule.
**Consequences:** A single bundled `dist/extension.js`; `vscode` and `@azure/identity` are kept external.

### 2. Auth model — VS Code Microsoft provider (primary), ClientSecretCredential (fallback)
**Decision:** Use `vscode.authentication.getSession('microsoft', …)` as the primary path; keep a documented `ClientSecretCredential` fallback for headless/CI.
**Why:** The provider is portable (incl. macOS, where `@azure/identity-vscode`'s `VisualStudioCodeCredential` is unsupported — Appendix C) and stores no app secret. The fallback reuses the proven orka token-cache pattern for automation contexts.
**Consequences:** Tokens are audience-bound — we request ARM and Foundry scopes as separate sessions. `@azure/identity` is an *optional* dependency, lazily imported.

### 3. Foundry API — new projects API (name+version identity)
**Decision:** Target the new Foundry projects API; agents identified by **name + version**.
**Why:** The classic agents API retires **2027-03-31** (Appendix A). API versions harvested and pinned: ARM `2022-12-01`, Cognitive `2025-06-01`, Foundry data `2025-05-01`.
**Consequences:** Re-verify versions against the latest SDK at build time; the new API shapes the internal agent model in Phase 2.

### 4. Secret storage — VS Code SecretStorage (not a custom vault)
**Decision:** Persist connection state via `context.secrets` (OS-keychain backed).
**Why:** VS Code owns encryption and key management; orka's AES-GCM `credentials-crypto.ts` becomes reference-only. Store as little as possible; prefer short-lived tokens.
**Consequences:** No `CREDENTIALS_MASTER_KEY` to manage; secrets are per-user/per-machine.

### 5. Orchestration framework — DEFERRED to Phase 4
**Decision:** Do not pick the orchestration framework now. **Microsoft Agent Framework (MAF) 1.0** is the leading candidate; confirm it can express our SDLC flows before committing.
**Why:** Phase 1 doesn't execute workflows; locking the framework early is the riskiest reversible-too-late call. T5's build-vs-buy spike informs it.
**Consequences:** Phase 4 produces the binding decision (and possibly a follow-up ADR).

### 6. Host/runtime location — DEFERRED to Phase 4
**Decision:** Governed runs execute on a server-side host (Foundry-hosted agents vs Azure Durable Functions — TBD), never in the editor. Location deferred.
**Why:** Durable state, managed identity, and auditability are Phase 4 concerns.
**Consequences:** The editor remains a client/preview surface only (a rule, not an open choice).

### 7. Canonical manifest schema — STUB for Phase 2
**Decision:** The normalized internal agent model (`id, name, description, instructions, tools, source-kind, source-path, raw`) is sketched but finalized in Phase 2's discovery engine.
**Why:** The manifest ecosystem is fragmenting; the schema is an adapter-pattern treadmill best fixed alongside the scanner.
**Consequences:** Phase 2 versions the internal model and owns this ADR's follow-up.

## Follow-ups
- T5: `BUILD_VS_BUY.md` is filled from documentation and code as of 2026-10-30. The hands-on Foundry Toolkit run that confirms the discovery gap is still pending (checklist at the end of that file).
- Phase 4: binding ADRs for decisions 5 and 6.
- Phase 2: binding ADR for decision 7.

## Status notes (added 2026-10-30)
- **Decision 5 (orchestration framework) was settled differently from the MAF candidate.** [ADR 0003](0003-langgraph-orchestration-engine.md) added an in-process LangGraph.js engine alongside the existing interpreter; [ADR 0002](0002-phase4-orchestration-engine.md) (Foundry-declarative hybrid) is superseded. The T5 research reinforces this: Foundry declarative workflows retire on 2026-12-01 and new workflows are expected to be Agent Framework code.
- **Decision 6 (host/runtime location) is still open.** Runs execute in the extension host today, which departs from this ADR's rule that governed runs never run in the editor. The T5 research notes that the Toolkit's hosted-agent starters include LangGraph, which makes a hosted-agent runtime a candidate; this has not been verified end to end.
- **Decision 7 (manifest schema)** was finalized in Phase 2 (`src/discovery/agentModel.ts`).
