# Phase 1 — Tasks

> **Phase 1 — Foundation, Auth & Build-vs-Buy Spike** (from `SDLC_WORKFLOW_ORCHESTRATION.md` §3).
> Goal: a loadable VS Code extension skeleton, real Azure auth, and an explicit written build-vs-buy decision — de-risking the hardest-to-reverse choices before any feature code.
>
> **Stack settled for Phase 1:** TypeScript + esbuild + `@vscode/vsce`; VS Code built-in **Microsoft** authentication provider (portable; `ClientSecretCredential` documented as the headless/CI fallback); new Foundry projects API (name+version identity). The orchestration framework (MAF) is **deferred to Phase 4** — only spiked/recorded here.

| ID | Task | Status |
|----|------|--------|
| T1 | Extension scaffold & activation | ✅ implemented |
| T2 | Azure sign-in via VS Code Microsoft provider | ✅ implemented |
| T3 | SecretStorage round-trip | ✅ implemented (automated round-trip test: `src/test/secrets/secretStore.test.ts`; reload survival still manual) |
| T4 | Foundry connection + project-list spike | ✅ implemented |
| T5 | Build-vs-buy matrix (Foundry Toolkit spike) | ✅ matrix filled from docs + code (2026-10-30) · ⏳ hands-on checklist pending (see `BUILD_VS_BUY.md`) |
| T6 | Phase 1 decision record (ADR) | ✅ accepted (`docs/adr/0001-phase-1-foundations.md`; follow-up notes added 2026-10-30) |

---

## T1 — Extension scaffold & activation

Stand up a TypeScript VS Code extension that builds via esbuild, activates on startup, registers the "SDLC Governance" activity-bar view container with an Overview tree, and packages to an installable VSIX with `@vscode/vsce`. Establishes the `package.json` contribution points (commands, views, viewsContainers), `tsconfig` (strict, no `any`), the esbuild bundler config, ESLint, and the `activate()`/`deactivate()` lifecycle. This is the load-bearing skeleton every later phase extends. **Exit:** the extension builds clean, runs in the Extension Development Host (F5) with the view rendering and the status command working, and `vsce package` emits a `.vsix` that installs into a clean VS Code.

## T2 — Azure sign-in via VS Code Microsoft provider

Wire `vscode.authentication.getSession('microsoft', scopes)` to obtain Azure AD tokens with the developer's work account — portable across macOS/Windows/Linux with no app-registration secret to store. Add `Sign in` / `Sign out` commands, reflect session state in the status bar and Overview tree, and handle the cancelled / no-session / wrong-tenant cases gracefully. Request the ARM scope for management-plane calls and the Foundry scope for the data plane (tokens are audience-bound, so each scope is a distinct session). Document the `ClientSecretCredential` fallback (harvested orka token-cache pattern) for headless/CI. **Exit:** sign-in succeeds end-to-end and a valid bearer token is acquired and silently reusable across calls without re-prompting.

## T3 — SecretStorage round-trip

Implement a thin typed `SecretStore` wrapper over `context.secrets` (`vscode.SecretStorage`, OS-keychain backed, encrypted at rest) to persist minimal connection metadata (selected tenant / subscription / resource-group / account) and, only if the user opts into the headless fallback, the client-secret credentials. Store as little as possible — prefer short-lived provider tokens over persisted secrets. Subscribe to `onDidChange` so the UI reacts to external secret changes, and expose a `Clear connection` command. This replaces orka's custom AES-GCM vault (`credentials-crypto.ts`) — VS Code owns the encryption and key management. **Exit:** a secret written via the wrapper survives an Extension Host reload and round-trips back identically; `Clear connection` removes it. *Verification split:* the write/read-back, malformed-value, `clear()` and `onDidChange` behaviour is covered by `src/test/secrets/secretStore.test.ts` (in-memory `SecretStorage`); survival across a real Extension Host reload needs the OS keychain and is checked by hand (README → "Run it interactively").

## T4 — Foundry connection + project-list spike

Port the pure orka Foundry logic — scopes, API versions (ARM `2022-12-01`, Cognitive `2025-06-01`, Foundry data `2025-05-01`), the 60s-grace token cache — and the list pipeline: subscriptions → resource groups → AIServices accounts → Foundry projects, using the T2 token via an injected `TokenProvider` (decoupling it from the repo's userId + Drizzle). Render an RBAC-scoped "Foundry Projects" tree with each project's account, resource group, subscription, and data-plane endpoint. Redact tokens from any error output (regex on the `eyJ…` JWT prefix). **Exit:** the signed-in user sees the live list of Foundry projects they can access — proving the harvested connection logic works outside Next.js/Drizzle. This validates the hardest cross-cutting dependency early.

## T5 — Build-vs-buy matrix (Foundry Toolkit spike)

Install the Microsoft Foundry Toolkit for VS Code, point it at one real SDLC agent/skill manifest from this repo's `.claude/`, and record, feature-by-feature, what the Toolkit already does versus what we must build: sign-in, project listing, deploy-to-Foundry, running evaluators — and crucially whether it auto-discovers `.claude` / `SKILL.md` / `AGENTS.md` (our differentiator rests on this gap's *absence of evidence*; confirm hands-on). Produce `BUILD_VS_BUY.md` classifying each feature as *already exists / extend / build new*. **Exit:** the matrix exists and is reviewed; the discovery gap is confirmed (or the roadmap pivots to pure policy/governance logic). *Status (2026-10-30):* `BUILD_VS_BUY.md` is filled from current Microsoft documentation and our own code, with every cell tagged `docs-verified` or `hands-on pending`. On documentation the discovery gap held (no pivot needed). It stays "absence of evidence" until someone runs the ~20-minute checklist at the end of `BUILD_VS_BUY.md`; that run, plus review of the matrix, is the only thing left to fully close T5.

## T6 — Phase 1 decision record (ADR)

Capture the hard-to-reverse calls in `docs/adr/0001-phase-1-foundations.md`: the orchestration framework candidate (MAF — confirm in Phase 4), new vs classic Foundry API (new; classic retires 2027-03-31), agent identity (name+version), where the host runtime executes (deferred), the canonical normalized manifest schema (stub for Phase 2), and the auth model (VS Code Microsoft provider with secret fallback). Each decision records context, the choice, and consequences. **Exit:** the ADR is written, linked from the README, and reviewed. This artifact is what stops later phases from silently rebuilding Toolkit features or re-deriving the orka logic we harvested.
