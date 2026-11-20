# Build-vs-Buy Matrix (T5) — Foundry Toolkit Spike

> **Status: filled from docs and code research (2026-10-30). Hands-on confirmation pending.**
> Every row below is backed by Microsoft documentation read on the date above, or by a code path in this
> repo. Cells marked **hands-on pending** could not be settled from documentation and need the
> [hands-on checklist](#hands-on-checklist-20-minutes) run in the VS Code GUI. Verdict vocabulary:
> **already exists** / **extend** / **build new**.
>
> North star: *if the Toolkit or the Foundry service already does it, wrap or extend it — do not rebuild it.*
> Our defensible value is narrow: cross-ecosystem discovery + normalization, org-specific orchestrator
> policy, and (only if validated) a thin visual canvas.

## Spike setup

- **Toolkit:** Microsoft Foundry Toolkit for Visual Studio Code (the new name for AI Toolkit; it also absorbed the
  separate Microsoft Foundry extension). Release notes read through **1.6.18 (28 Oct 2026)**. The installed version used
  for the hands-on run is _to record during the checklist_.
- **Date / tester:** 2026-10-30 — documentation and code research (Claude Code session). Hands-on tester: _assign_.
- **Manifest used for the hands-on run:** `.claude/agents/ba-agent/requirements-analyst/AGENT.md`
  (a real SDLC agent manifest from this repo; also used by the default workflow in `src/runtime/sdlcDefaultSpec.ts`).

## Feature matrix

`Evidence status`: **docs-verified** = settled by the cited documentation; **hands-on pending** = needs the checklist.

| # | Capability | Toolkit provides it? | Verdict | Notes / evidence | Evidence status |
|---|---|---|---|---|---|
| 1 | Azure / Microsoft sign-in | **Yes.** "Sign in to Azure and set a Foundry project to manage cloud resources." [S1] The docs do not say which auth mechanism it uses; for local agent code they say "Toolkit sign-in selects the project for extension operations. The local agent process also needs a supported credential" (`az login` / `DefaultAzureCredential`). [S3] | **already exists** | Do not build a login UI. We keep only the VS Code `microsoft` provider session (`src/auth/azureAuth.ts`) because tokens are audience-bound and our own commands need ARM + Foundry tokens. | docs-verified; **whether the Toolkit shares our VS Code Microsoft session: hands-on pending** |
| 2 | List Foundry projects (RBAC-scoped) | **Yes.** "Browse Foundry projects and the resources available to your account" under *My Resources*. [S1] | **already exists** | Our `foundryClient.ts` walk + `foundryProjectsProvider.ts` was the T4 spike. Keep it only where governance needs a project picker (eval target); do not extend it into a project browser. | docs-verified; list parity with our view: hands-on pending |
| 3 | Deploy agent to Foundry | **Yes, for code-based hosted agents.** *Deploy to Microsoft Foundry* offers **Code** (Remote or Bundled package, no local Docker needed for Remote) or **Container** (default or custom ACR, remote ACR build, or a prebuilt ACR image). Needs the **Foundry Project Manager** role at project scope; the deployed agent runs under its own runtime identity, not the user's. [S3] Hosted-agent support in the Toolkit was announced GA in April 2026 [S7]. | **already exists** | Real steps are documented, so the plan's "verify the one-click claim" is answered: source or image + ACR + runtime-identity permissions. We do **not** build deploy. Gap: it deploys *code projects*, not our discovered markdown manifests; registering a discovered agent by name+version (plan Phase 4) is still ours and is not implemented. | docs-verified |
| 4 | Run built-in evaluators | **Yes.** Evaluate "models, prompts, and agents with datasets, built-in evaluators, or custom criteria." [S1] The *Evaluation* view is based on the Azure Evaluation SDK [S8]. | **extend** | The Toolkit runs evaluators; it does not turn a score into a blocking decision. We call Foundry evals ourselves (`src/eval/evalClient.ts`) so the result can feed `gateDecision`/`gatePolicy`. Our value is the gate, not the runner. | docs-verified; GA/preview split per evaluator: hands-on pending |
| 5 | Run custom evaluators (code / prompt) | **Yes** (custom evaluator creation in the Evaluation view [S8]; cloud-side code evaluators are `grade()` functions in a sandbox [S8]). | **extend** | `src/eval/customEvaluators.ts` registers ours via the preview `project.beta.evaluators` surface and degrades gracefully if it is unavailable. Preview status of the cloud service was **not re-confirmed** in this pass; keep the non-preview fallback. | docs-verified (existence); preview status: hands-on pending |
| 6 | **Auto-discover `.claude` / `SKILL.md` / `AGENTS.md`** | **No evidence it does.** Skills are *uploaded* into Foundry (inline, `.md` file or ZIP via *Tools → Skills → Add skill → Upload*) or added from the *Tool Catalog*, then stored centrally via the Skills API. [S4] Nothing in the overview, hosted-agent, tracing or skills pages describes scanning a workspace. Release notes 1.6.16 to 1.6.18 contain no such item (only a *bundled* skill shipped with the extension). [S6] | **build new** | **The differentiator held up on documentation.** Nuance: for `SKILL.md` the Toolkit has an *import* path, so our discovery adapter (`src/discovery/adapters/claudeSkill.ts`) should be able to hand off to it rather than compete with it. Note the Skills API is **preview** [S4]. | docs-verified (absence of evidence only); **hands-on confirmation pending** |
| 7 | Normalize heterogeneous manifests → one model | **No.** Not described anywhere in the Toolkit documentation. | **build new** | Phase 2: `src/discovery/normalizer.ts`, `agentModel.ts`, `dedupe.ts` and six adapters under `src/discovery/adapters/`. | docs-verified (absence of evidence) |
| 8 | Declarative workflow authoring | **Retiring.** "Declarative workflows in Microsoft Foundry are in preview and **retire on December 1, 2026**. Use Microsoft Agent Framework for new workflow development." The Toolkit's workflow graph is **read-only**; editing is by exported YAML or the portal, and local YAML edits do not change the Foundry workflow. [S2] | **do not build on it** | Two consequences. (a) The hybrid "Foundry runs our YAML declaratively" idea in ADR 0002 is on a retiring surface; ADR 0003's in-process LangGraph engine is the right call. (b) Our builder's YAML view should be treated as export-only; do not deploy it to Foundry's declarative service. (I have not checked which YAML dialect `src/webview/ui/YamlView.tsx` emits.) | docs-verified |
| 9 | Free-form visual canvas | **No authoring canvas.** The declarative graph is read-only [S2]; *Agent Inspector* visualizes execution of a local Agent Framework workflow [S1][S3]. | **build new — gated (Phase 5)** | Already built here (`src/webview/ui/*`), well beyond the plan's "read-mostly visualizer". The plan's demand gate (build only if users ask) was not applied. | docs-verified |
| 10 | Org-specific orchestrator policy (which gate blocks which step) | **No.** | **build new** | `src/eval/sdlcSteps.ts` (step → evaluators/thresholds), `gatePolicy.ts`, `gateDecision.ts`. **Not yet wired into runs:** the runtime still uses `StubGateEvaluator` (`src/extension.ts:86`). | docs-verified (absence of evidence) |
| 11 | OpenTelemetry tracing → App Insights | **Yes, for development and for hosted agents.** A local OTLP collector (gRPC 4317, HTTP 4318, stored in a local SQLite `traces.db`), and hosted-agent traces read from the project's connected Application Insights (detail query covers the last 7 days). GenAI semantic conventions determine what the viewer shows. [S5] | **extend** | `src/telemetry/tracing.ts` exports governed-run spans to App Insights with content recording off by default. Do not rebuild a trace viewer; link out to the Toolkit's. | docs-verified |
| 12 | Append-only audit store / SIEM wiring | **No.** Local traces are a deletable local database ("select the traces… and select Delete"); cloud telemetry follows the App Insights / Log Analytics configuration. [S5] | **build new** | `src/audit/auditStore.ts`, `auditRecord.ts` and `logAnalyticsSink.ts` (Log Analytics ingestion). Neither Toolkit store is append-only, so this is genuinely ours. | docs-verified |

### Sources (all read 2026-10-30 unless noted)

- **[S1]** Toolkit overview — <https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/get-started-projects-visual-studio-code>
- **[S2]** Declarative workflows and migration — <https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/vs-code-agents-workflow-low-code>
- **[S3]** Create hosted agents (deploy, auth, Agent Inspector) — <https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/vs-code-agents-workflow-pro-code>
- **[S4]** Skills (preview) — <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/skills>
- **[S5]** Tracing — <https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/vs-code-tracing>
- **[S6]** Toolkit release notes — <https://github.com/microsoft/foundry-dev-tools/blob/main/WHATS_NEW.md> (first ~100,000 of ~124,000 characters read; claims are limited to the three latest releases, 1.6.16 to 1.6.18)
- **[S7]** Hosted-agent GA announcement — <https://mc.merill.net/message/AZ560987> (seen as a search result only, not opened)
- **[S8]** Evaluation in the Toolkit — <https://code.visualstudio.com/docs/intelligentapps/evaluation> and Foundry custom-evaluators docs (seen as search results only, not opened)

## Decision summary

- **Wrap or reuse, do not rebuild:** sign-in (1), project browsing (2), hosted-agent deploy (3), evaluator running and custom evaluator authoring (4, 5), trace viewing (11). For 4, 5 and 11 we **extend**: our code adds the gating, degrade-on-failure and governed-run export around what Foundry already runs.
- **Build new:** discovery and normalization (6, 7), org-specific gate policy (10), the append-only audit trail (12), and the canvas (9, already built).
- **The discovery differentiator held up on documentation.** Neither the overview, the hosted-agent, tracing or skills pages, nor the three latest release notes describe workspace scanning of `.claude`, `SKILL.md` or `AGENTS.md`. This is still absence of evidence until the checklist confirms it. **No pivot to pure policy/governance is needed on current evidence.** Re-check the Toolkit release notes monthly, as the plan's cross-cutting gate requires.
- **Overlap to manage:** the Toolkit already has a skills *import* path (upload or catalog, stored via the preview Skills API). Position our `SKILL.md` adapter as discovery plus optional hand-off to it, not a competing store.
- **Two findings that change earlier decisions (to carry into the ADRs):**
  1. Foundry declarative workflows retire on **2026-12-01**, and new workflows are meant to be Agent Framework code. ADR 0002's hybrid approach is moot, and ADR 0003 is consistent with this.
  2. The Toolkit's *Create Agent* flow lists **Agent Framework, Copilot SDK and LangGraph** as hosted-agent starters. [S3] A LangGraph-based runtime can plausibly be deployed as a Foundry hosted agent later, which is relevant to the still-open ADR 0001 decision 6 (host location). Not verified end to end.

## Hands-on checklist (~20 minutes)

Run this once in VS Code with your work account, then flip the cells above from **hands-on pending** to **hands-on verified** (and record the installed Toolkit version in *Spike setup*).

1. **Install** *Microsoft Foundry Toolkit* from the Marketplace. Note the version (Extensions view).
2. **Open this repo** as the workspace so `.claude/agents/**/AGENT.md` and `.claude/skills/**/SKILL.md` are present.
3. **Discovery gap (rows 6, 7):** open the Foundry Toolkit view. Look in *My Resources*, *Tools → Skills* and the *Tool Catalog*. Confirm none of them lists this repo's `.claude` agents or skills without you uploading them. Also run the Command Palette and type *Foundry Toolkit* to see if any command mentions discovering or importing local agents.
4. **Sign-in (row 1):** sign in through the Toolkit. Then run **SDLC Governance: Show Status**. Record whether our extension already shows you as signed in (shared session) or prompts again.
5. **Project list (row 2):** compare the Toolkit's project list with our **Foundry Projects** view. Record any difference.
6. **Evaluators (rows 4, 5):** open *Tools → Evaluation → Create Evaluation* and note which built-in evaluators are labelled preview. Open the *Evaluators* tab and confirm you can create a custom evaluator.
7. **Deploy (row 3):** open *Deploy to Microsoft Foundry* and read the wizard fields through *Review + Deploy*, without deploying. Confirm they match the documented Code / Container options.
8. **Declarative workflow (row 8):** if your project has a declarative workflow, open it from *Agents → Workflow* and confirm the graph is read-only and the retirement notice is shown.
9. **Record** each result next to its row above, and add the date and your name to *Spike setup*.
