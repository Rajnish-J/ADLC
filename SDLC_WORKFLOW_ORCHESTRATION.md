# SDLC Agent Governance Platform — VS Code Extension + Host Application

> **Phased build plan for a standalone product.** This document supersedes the earlier "Plan A / Plan B" approach that integrated orchestration into the existing Next.js analytics app. That integration is **retired** — we are building a **separate, distributable VS Code extension plus a companion host/runtime** (VSIX + host service), not embedded in this repo's web app.
>
> **Scope note:** the **devcontainer / microVM sandbox** ("prompt-only, everything automated" future state) is **out of scope** for this plan — parked as a post-v1 bet (see §6), not one of the five phases.
>
> **Framework, SDK, and vendor selections are deliberately deferred.** Each phase lists _candidates to confirm_, not locked choices. We pick the stack after this plan is agreed (see §7).

> **✅ Coherence check (this revision).** The 5-phase spine was re-verified end-to-end. Each phase now carries Goal → Deliverables → Exit criteria → **Harvest** pointer. Four consistency fixes were applied: (1) the "editor vs host" decision is reframed as a _rule_ (governed → host, preview → editor), not an open choice; (2) "host/runtime" is now defined; (3) the eval gate is clarified as **two layers** — CI/PR-time (Phase 3) and in-run (Phase 4) — so they no longer read as contradictory; (4) Foundry API versions are pinned to the concrete values already proven in this repo's `orka` feature. The biggest addition is the **Harvest map (§3.5)** — this repo _already has_ a working orchestrator + Foundry integration whose pure logic we port rather than re-derive.

---

## 1. Product summary

A VS Code extension (the **client**) plus a companion **host/runtime** (the **server**) that governs AI agents across the software development lifecycle. The platform:

1. **Discovers** heterogeneous on-disk agent/skill manifests in any workspace (`.claude/agents/`, `.claude/skills/SKILL.md`, `AGENTS.md`, `agent.yaml`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`) and normalizes them into one internal agent model.
2. **Chains** discovered agents into SDLC workflows on a visual canvas that compiles down to a declarative workflow definition.
3. **Evaluates** each SDLC step against quality/safety evaluators, with gates that can **block** a run or PR — not just display a score.
4. **Audits** every run with end-to-end tracing into an append-only store wired to a SIEM, mapped to the compliance frameworks (EU AI Act logging, NIST AI RMF, ISO 42001, SOC 2 — see Appendix B).
5. **Orchestrates** governed runs on the **host/runtime**, with a master-orchestrator policy engine deciding which gates apply to which step and what blocks a run.

> **Term — "host / runtime":** a server-side process _distinct from the VS Code extension process_, where governed runs actually execute (candidate: Foundry-hosted agents or Azure Durable Functions; tech deferred to §7). The extension is the client UI; the host owns durable state, managed identity, and the audit trail. Governed runs **never** execute inside the editor.

### Build-vs-buy north star

The single most important discipline: **if the Microsoft Foundry Toolkit for VS Code or the Foundry service already does it, wrap or extend it — do not rebuild it.** Sign-in, project listing, deploy-to-Foundry, and running evaluators are GA in the Toolkit. Equally: **harvest the proven pure logic already in this repo's `orka` feature (see §3.5) — do not re-derive it.** Our defensible, build-it-ourselves value is narrow and deliberate:

- **The cross-ecosystem discovery + normalization layer** (the Toolkit does _not_ scan the filesystem for third-party manifests).
- **The org-specific master-orchestrator policy logic** (which evaluator gates apply to which SDLC step, and what blocks a run).
- **A thin free-form visual canvas** over the workflow definition — _only if users validate the need_; the Toolkit deliberately chose YAML-declarative over a blank canvas.

---

## 2. Architecture at a glance (layers / swimlanes)

| Layer                                 | Lives in                                     | Responsibility                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1 — VS Code Extension (client)**   | Extension host (TypeScript) + webview        | Auth, tree views (discovered agents / projects / eval results), commands (Discover, Evaluate, Deploy), and the visual canvas. Secrets in `SecretStorage`.                   |
| **L2 — Local Workspace**              | The developer's repo                         | Source manifests; consumed by the discovery engine → internal agent model → workflow definition.                                                                            |
| **L3 — Discovery & Normalization**    | Extension or host                            | Scans manifests, normalizes heterogeneous schemas into one internal agent model, validates, dedupes.                                                                        |
| **L4 — Orchestration Runtime (host)** | **Server / Foundry-hosted — NOT the editor** | Executes workflows (sequential / handoff / group-chat patterns) + master-orchestrator policy engine (gates, approvals, redaction, retries, budgets) + agent hand-off/state. |
| **L5 — Azure AI Foundry**             | Azure                                        | Agent Service (name+version agents), built-in + custom evaluators, Control Plane (inventory, guardrail policies), AI gateway.                                               |
| **L6 — Audit / Governance**           | Azure + SIEM                                 | OpenTelemetry → App Insights/Azure Monitor; append-only Log Analytics/SIEM; Purview (audit, DSPM, PII); CI/CD eval gate.                                                    |

**Decision points (diamonds) that recur across phases:** Framework detected? → which template. Manifest schema valid? → register vs skip. Evaluator gate passed? → proceed vs block PR. Human approval required? → pause/resume. **Governed run? → host runtime; local preview only? → editor** (this is a rule, not an open choice).

**Out of scope (parked):** ephemeral microVM devcontainers, scoped per-task Git tokens, deny-by-default egress, prompt-only UX. Revisit only after the five phases below are adopted.

---

## 3. The five phases

> Each phase is independently shippable and ends with a demoable, verifiable outcome. Effort ranges are directional, pending framework selection. The MVP value (Phases 1–3) is **discovery + an enforcing evaluator gate**, _not_ the visual builder — the canvas is intentionally last.

---

### Phase 1 — Foundation, Auth & Build-vs-Buy Spike

**Goal:** A loadable VS Code extension skeleton, real Azure auth, and an explicit, written build-vs-buy decision for every proposed feature. De-risk the hardest-to-reverse choices before writing feature code.

**Deliverables**

- VS Code extension scaffold (TypeScript) packaged as an installable VSIX; activation, command registration, one placeholder tree view.
- Azure sign-in working end-to-end (candidate: VS Code built-in Microsoft authentication provider for portability; `@azure/identity-vscode` `VisualStudioCodeCredential` is a fallback but is **Windows/Linux only — no macOS**, see Appendix C).
- Secrets stored via `context.secrets` (`SecretStorage`), backed by the OS keychain — store as little as possible; prefer short-lived tokens.
- A hands-on spike of the **Foundry Toolkit** against one of our real SDLC plugin/agent manifests, producing a **feature-by-feature build-vs-buy matrix**: _already exists / extend / build new_.
- A **decision record** capturing the hard-to-reverse calls (finalized after this plan): orchestration framework, new vs classic Foundry API, agent-identity model (name+version), where the orchestrator runs, the normalized manifest schema, and the auth model.

**Candidates to confirm (not locked)**

- Orchestration framework: **Microsoft Agent Framework (MAF) 1.0** is the leading candidate (GA, graph workflows, checkpointing, pause/resume, human-in-the-loop, OTEL). Validate it can express our SDLC flows before committing.
- Foundry API: target the **new Foundry projects API** (name+version agent identity); avoid the classic API (retires Mar 31 2027 — Appendix A).
- Host runtime location: server/Foundry-hosted for governed runs; the editor is for local dev/preview only.

**Harvest:** Foundry connection shape, scopes, and API versions from `src/service/foundry.service.ts` + `src/types/orka/foundry.types.ts`; the per-user token-cache pattern; `src/lib/credentials-crypto.ts` as a _reference_ (in the extension prefer `SecretStorage` over a custom vault). See §3.5.

**Exit criteria / verification**

1. Extension installs from VSIX and activates; a command runs and a tree view renders.
2. Sign-in succeeds; an RBAC-scoped list of accessible Foundry projects is fetched and displayed.
3. A secret round-trips through `SecretStorage`.
4. The build-vs-buy matrix and decision record exist and are reviewed.

**Risks addressed:** macOS auth portability; rebuilding Toolkit features by accident; locking in the wrong API/framework.

---

### Phase 2 — Discovery & Normalization Engine _(the core differentiator)_

**Goal:** Scan any workspace for heterogeneous agent/skill manifests and normalize them into a single internal agent model, surfaced as a tree view. This is the capability the Foundry Toolkit does **not** provide.

**Deliverables**

- Workspace scanner (VS Code FileSystem / workspace APIs) that finds and parses:
  - `.claude/agents/*.md`, `.claude/skills/**/SKILL.md` (YAML frontmatter: `name`, `description`)
  - `AGENTS.md` (vendor-neutral standard, widely adopted)
  - `agent.yaml`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`
- A **normalizer** that maps each source schema into one **internal agent model** (single canonical shape: id, name, description, instructions, tools, source-kind, source-path, raw).
- Schema validation + a "valid / skip / needs-attention" status per manifest, with diagnostics in VS Code's Problems panel.
- Dedupe across overlapping conventions (same agent declared in multiple files).
- A **"Discovered Agents" tree view** grouped by source kind, with a detail view per agent.
- A `Discover` command (and auto-discover on workspace open, debounced).

**Design notes**

- Treat the normalizer as a **maintenance treadmill** — the manifest ecosystem is fragmenting and unstandardized. Build it adapter-style (one adapter per convention) so new conventions are additive, and version the internal model.
- **Security:** SKILL.md bundles can ship scripts. Discovery must **never execute** discovered code — parse only, and flag bundled scripts for human audit.

**Harvest:** the 9-kind **node taxonomy** from `src/components/workflow-builder/canvas/nodes/*` (data model only) and the graph/entry-node logic from `src/lib/orka/orchestrator/graph.ts` to shape the internal model. See §3.5.

**Exit criteria / verification**

1. Point the extension at a repo containing all manifest types; every agent appears in the tree, correctly attributed to its source.
2. A malformed manifest shows a clear diagnostic and is skipped, not crashed on.
3. Two conventions declaring the same agent dedupe to one internal entry.
4. No discovered script is ever executed during scanning (verified by audit/log).

**Risks addressed:** the differentiator is real and works; normalizer upkeep is bounded by the adapter pattern.

---

### Phase 3 — Evaluation & Enforcing Governance Gate _(the MVP value)_

**Goal:** Wire SDLC steps to Foundry evaluators, stream tracing to an audit store, and ship **one governance gate that actually blocks** a run/PR below threshold — closing the "governance theater" gap. This, not the canvas, is the product's reason to exist.

**Deliverables**

- Evaluation invocation against Foundry evaluators:
  - A few **built-in** evaluators relevant to SDLC steps (e.g. Task Adherence, Intent Resolution, Tool Call Accuracy, Coherence; safety evaluators where relevant — full catalog in Appendix A).
  - **One or two custom evaluators** (code-based `grade()` for deterministic format/keyword rules; one prompt-based LLM-judge) — **preview**.
- **OpenTelemetry tracing** wired into Application Insights / Azure Monitor (GenAI semantic conventions). Distinct `agent_reference` per agent. Content recording **off by default** (PII).
- An **append-only audit store** (Log Analytics / SIEM destination) — every evaluator result and run transition lands here, not just in the IDE.
- **One enforcing gate (CI/PR-time layer):** an evaluator result below threshold **fails the run / blocks the PR**. Candidate mechanism: the `microsoft/ai-agent-evals` GitHub Action (or the Azure DevOps task) — both **preview**, confirm before depending.
  - _Note:_ this is the **first of two gate layers**. Phase 4 adds an **in-run** gate inside the orchestration runtime. They are complementary, not duplicative — CI/PR-time catches bad changes before merge; in-run catches bad steps mid-execution.
- An **Evaluation Results panel** (tree/webview) showing per-step scores, pass/fail, and the gate decision.
- **Cost controls from day one**: sampling instead of every-step, cheap judge models where quality allows, threshold-triggered (not every-commit) runs, and an Azure Cost Management budget scoped to the Foundry resource group.

**Design notes**

- **Enforcement is the point.** Every evaluator result must have an enforcement path (block PR, require approval, redact) — a score with no consequence is compliance optics without control.
- **Cost is the #1 runaway vector**: evaluators × every step × every team × multiple judge calls. Gate spend deliberately; alert if eval spend exceeds ~10–15% of model inference spend.

**Harvest:** Foundry data-plane call pattern (threads → messages → runs poll) and usage/token mapping from `src/lib/orka/orchestrator/dispatch/foundry.ts`. See §3.5.

**Exit criteria / verification**

1. Running evaluation on a sample SDLC step produces scores in the panel and a trace in App Insights.
2. A deliberately failing step **blocks** the gate (PR check goes red / run fails) — verified end-to-end, not mocked.
3. The audit store contains an append-only record of the run and the gate decision.
4. Cost budget + alert are configured and fire on a synthetic overspend.

**Risks addressed:** governance theater; runaway eval cost; "scores but no control."

---

### Phase 4 — Orchestration Runtime & Master Orchestrator _(host, not editor)_

**Goal:** Execute multi-agent SDLC workflows on the **host/runtime** with managed identity, driven by a master-orchestrator policy engine. Discovered agents compile into the runtime's workflow definitions.

**Deliverables**

- Adopt the confirmed orchestration framework (MAF candidate) hosted in the **host runtime** — explicitly **not** the editor process, because governed runs need durable state, managed identity, and auditability the editor can't provide.
- A **compiler**: internal agent model (Phase 2) → orchestration framework workflow definition (candidate: MAF YAML / graph). Workflows are version-controllable.
- **Master-orchestrator policy engine (in-run gate layer):** per-step evaluator gates (which gate applies to which SDLC step), human-in-the-loop approvals (pause/resume), PII/secret redaction, retries, and **per-workflow budgets / max-step caps** (so loops can't burn tokens indefinitely).
- Orchestration patterns wired: sequential, concurrent, handoff, group-chat / manager-led, with agent hand-off and state via the framework's session model.
- Run lifecycle surfaced in the extension: start a run, watch live status, pause on approval, resume, cancel.
- Foundry **Agent Service** registration of agents by **name + version**.

**Design notes**

- Build a custom orchestrator **only** if a concrete SDLC workflow cannot be expressed in the chosen framework — document the specific gap first.
- Long-running, auditable runs belong on the host (e.g. durable functions / Foundry-hosted agents), using the **caller's** stored credential, never a shared org credential.

**Harvest:** graph traversal + condition precedence (`src/lib/orka/orchestrator/graph.ts`, `conditions.ts`), workflow→YAML codegen (`src/lib/orka/workflow-yaml.ts`), Foundry dispatch loop (`dispatch/foundry.ts`), and the run/step/audit **data shape** (`orkaWorkflowRuns/Steps/Audits` in `src/db/schema.ts`) — storage swaps to the host store. See §3.5.

**Exit criteria / verification**

1. A discovered multi-agent workflow compiles to the framework definition and runs to completion on the host runtime.
2. A step requiring approval **pauses**, and resumes on human action.
3. A workflow that loops hits the max-step budget and stops with a clear audit entry.
4. Every run is attributable to the triggering user and lands in the audit store with full traces.

**Risks addressed:** ephemeral editor state for governed runs; runaway loops; build-vs-buy drift toward a bespoke orchestrator.

---

### Phase 5 — Visual Builder & Control Plane _(gated on demand)_

**Goal:** Add a free-form visual workflow surface and connect to the Foundry Control Plane for fleet visibility and guardrail policies — but only build the canvas if Phases 1–4 users actually asked for it, and build it as a **visualizer/light editor over the workflow definition**, not the primary authoring surface.

**Deliverables**

- **React Flow** canvas in a sandboxed webview (strict CSP, `vscode-webview` URIs, `postMessage` bridge, stateless via `getState`/`setState`):
  - Custom nodes (trigger / agent / condition / goto / end) as React components.
  - Workflow persists as JSON (`{nodes, edges}`) that **compiles to the same framework definition** from Phase 4 — the canvas is a view over the source of truth, not a parallel runtime.
  - Per-node execution-state overlays driven by the live run stream from Phase 4.
- **Foundry Control Plane** integration: fleet inventory of discovered/registered agents, versioned **guardrail policies**, and bulk remediation of non-compliant agents (Compliance pane).
- Optional **Purview** enablement (preview) where compliance requires: audit, DSPM for AI, PII/SIT classification.
- **Continuous evaluation** against production traffic with alerting (beyond the PR-time gate of Phase 3).

**Reality-check on the canvas (state this to stakeholders)**

- React Flow itself is ~1 week for a basic canvas, but production polish — auto-layout (Dagre/ELK integrations are fragile; many teams hand-roll), edge routing, schema-driven config panels per node, execution overlays — is reportedly **14–25 weeks of senior-dev work**. It is the **riskiest, lowest-ROI** component.
- Industry signal: developers bypass visual builders once flows get complex; the Toolkit deliberately chose YAML. **Default position: ship the canvas as a read-mostly visualizer.** Promote it to a full authoring surface only on validated demand.

**Harvest:** the React Flow node components (`src/components/workflow-builder/canvas/nodes/*`) and the Dagre auto-layout (`src/lib/orka/workflow-layout.ts`) are the closest-to-drop-in port sources — though the rendering is React Flow-specific and the surrounding shadcn/Next.js wiring is not portable. See §3.5.

**Exit criteria / verification**

1. A workflow authored/edited on the canvas round-trips to the framework definition and runs identically to a hand-authored one.
2. Node states animate live during a run.
3. The Control Plane shows the agent fleet and flags a non-compliant agent against a guardrail policy.
4. (If enabled) Purview classifies a synthetic PII payload in a run.

**Risks addressed:** shelfware canvas; visual-builder scope blowout; missing org-wide fleet governance.

---

## 3.5 Harvest map — what to port from this repo's `orka` feature

This repo _already ships_ a working orchestrator + Foundry integration. Port its **pure logic**; rebuild only the Next.js/Drizzle-coupled parts. (Paths verified to exist.)

| New extension need                                                                   | Harvest from `orka`                                                                                                                                                                                                             | Portability                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Workflow → YAML codegen                                                              | `src/lib/orka/workflow-yaml.ts` (emits `kind: workflow`, `InvokeAzureAgent`, `ConditionGroup`, `SetVariable`, `SendMessage`, `GoToNode`)                                                                                        | **Pure — port directly**                                                           |
| Graph traversal / entry-node / condition precedence                                  | `src/lib/orka/orchestrator/graph.ts`, `conditions.ts`                                                                                                                                                                           | **Pure — port directly**                                                           |
| Auto-layout (Dagre, left→right)                                                      | `src/lib/orka/workflow-layout.ts`                                                                                                                                                                                               | **Pure — port directly**                                                           |
| Foundry scopes / API versions / connection shape                                     | `src/types/orka/foundry.types.ts`, `src/service/foundry.service.ts` — ARM `2022-12-01`, Cognitive `2025-06-01`, **Foundry data `2025-05-01`**; scopes `https://management.azure.com/.default` + `https://ai.azure.com/.default` | Reusable enums/constants — **re-verify versions against latest SDK at build time** |
| Token cache (per-user, 60s grace)                                                    | `src/service/foundry.service.ts`                                                                                                                                                                                                | Reusable pattern                                                                   |
| Credential AES-GCM crypto                                                            | `src/lib/credentials-crypto.ts`                                                                                                                                                                                                 | Reference only — **prefer `SecretStorage`** in the extension                       |
| Node taxonomy (9 kinds: trigger/agent/condition/set-var/reset-var/ask/goto/end/note) | `src/components/workflow-builder/canvas/nodes/*`                                                                                                                                                                                | Data model reusable; React Flow rendering is coupled                               |
| Foundry dispatch (threads → messages → runs poll, usage mapping)                     | `src/lib/orka/orchestrator/dispatch/foundry.ts`                                                                                                                                                                                 | Logic reusable; Drizzle persistence is coupled                                     |
| Run / step / audit data shape                                                        | `orkaWorkflowRuns` / `orkaWorkflowSteps` / `orkaWorkflowAudits` in `src/db/schema.ts`                                                                                                                                           | Shape reusable; storage swaps to host store                                        |

**Not portable (rebuild):** Next.js API routes, Drizzle/Postgres persistence, shadcn/Tailwind components, `require-auth`/session context, React Flow canvas wiring.

---

## 4. Cross-cutting concerns (apply to every phase)

- **Build-vs-buy gate:** before building anything, check it against the Phase 1 matrix _and_ the Harvest map (§3.5). **Watch the monthly Foundry release notes** — if the Toolkit ships filesystem auto-discovery or a free-form canvas, our differentiation evaporates and we pivot to pure policy/governance logic.
- **Preview-feature caution:** custom evaluators, Foundry-hosted agents, `ai-agent-evals` Action / ADO task, and Purview-in-Foundry are **preview** — no SLA, can change. Validate before depending; keep a non-preview fallback for anything on the critical path. (Appendix C.)
- **Security/supply-chain:** audit forked SKILL.md/script bundles; never execute discovered code during scanning; scope all Git tokens narrowly; minimize what's in `SecretStorage`; constrain agent repo-write/PR permissions; prefer short-lived tokens over long-lived secrets.
- **Compliance:** a single cross-framework AI register + append-only trace store satisfies the overlapping EU AI Act / NIST AI RMF / ISO 42001 / SOC 2 inventory+logging requirements (Appendix B). Don't hard-code a log-retention figure — the technical standard isn't finalized; have legal/compliance confirm jurisdiction and risk classification.
- **Cost governance:** sample, use cheap judges, trigger on thresholds/PRs (not every commit), scope Azure budgets to the Foundry resource group, alert at ~10–15% of inference spend.

## 5. Team & skills (for the five phases)

- 1 × VS Code extension / TypeScript engineer (L1, L2, L3 client surfaces).
- 1 × Azure / Foundry + orchestration-framework engineer (Python/.NET) (L4, L5).
- 1 × platform / DevOps engineer (App Insights, ACR, CI/CD eval gate, host runtime) (L6).
- Part-time security/compliance owner (cross-cutting).
- Part-time React / React Flow specialist — **Phase 5 only**.
- A PM/tech lead owning the build-vs-buy line so the team never drifts into rebuilding the Toolkit.

## 6. What's intentionally NOT in this plan

- **Devcontainer / microVM sandbox** ("prompt-only, everything automated" autonomous runs). Parked as a post-v1 bet, gated on adoption of Phases 1–4 and a proven security/cost model. When revisited: microVMs (Firecracker/Kata) — **not** plain Docker — scoped per-task Git tokens, deny-by-default egress, time-limited per-workspace credentials.
- **Integration into the existing Next.js analytics app.** This platform ships as its own VS Code extension + host. The prior Plan A / Plan B web-app integration is **retired** (we harvest its logic per §3.5, but do not extend the web app).

---

## 7. Open decisions to settle _after_ this plan is approved

_(Deliberately left open — these drive framework and vendor selection.)_

1. Orchestration framework — confirm MAF, or justify an alternative against concrete SDLC workflows.
2. New vs classic Foundry projects API (recommend new; classic retires Mar 31 2027).
3. Agent-identity model — name+version (recommend) vs GUID.
4. Where the host runtime executes — Foundry-hosted agents vs Azure Durable Functions vs other.
5. The canonical internal manifest schema the normalizer targets.
6. Auth model — VS Code Microsoft provider (portable) vs `DefaultAzureCredential` / `VisualStudioCodeCredential` (macOS gap).
7. Gate mechanism — `ai-agent-evals` GitHub Action vs ADO task vs custom (mind preview status).
8. Whether the React Flow canvas (Phase 5) is built at all — gate on Phase 1–4 user demand.

---

# Appendices (reference detail — not required to read the plan)

## Appendix A — Azure AI Foundry reference (mid-2026)

**SDKs:** `pip install "azure-ai-projects>=2.0.0"`, `npm install @azure/ai-projects`, `dotnet add package Azure.AI.Projects` (+ Java). Agents in the new projects API are identified by **name + version**, not a GUID. Classic agents API retires **March 31, 2027** — target the new API.

**Built-in evaluator catalog:**

- **RAG:** Retrieval, Document Retrieval, Groundedness, Groundedness Pro, Relevance, Response Completeness.
- **Agent:** Intent Resolution, Task Adherence, Tool Call Accuracy (+ task completion / navigation / tool-selection variants).
- **General purpose:** Coherence, Fluency, QA.
- **Textual similarity:** Similarity, F1, BLEU, GLEU, ROUGE, METEOR.
- **Risk & safety:** Hate/Unfairness, Sexual, Violence, Self-Harm, Protected Materials, Indirect Attack/XPIA, Code Vulnerability, Ungrounded Attributes, Prohibited Actions, Sensitive Data Leakage.
- **Composite:** QAEvaluator, ContentSafetyEvaluator. **Azure OpenAI graders** also available.
- Most quality evaluators are **LLM-as-judge** (need a GPT judge deployment; return 1–5 or pass/fail). Safety + Groundedness Pro run on Azure AI Content Safety.

**Custom evaluators (preview):** **code-based** (`grade()` Python fn, deterministic 0.0–1.0) and **prompt-based** (LLM judge prompt; ordinal/continuous/binary). Created in portal or via SDK (`code_text`/`prompt_text` + `data_schema` + `metrics`).

**Tracing:** OpenTelemetry GenAI semantic conventions → Application Insights (90-day server-side retention). Content recording off by default (`AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED`).

**RBAC roles (renamed; IDs unchanged):** Foundry User / Foundry Owner / Foundry Account Owner / Foundry Project Manager. Running evals needs **Foundry User**; creating guardrail policies needs Owner or Resource Policy Contributor; Purview integration needs Foundry Account Owner.

**Cost driver:** token volume from multiplied calls ≈ `TestCases × RunsPerCase × PromptVariants` generation calls + judge calls. Judge-model choice dominates at scale (mini vs GPT-4o-class).

## Appendix B — Compliance mapping

- **EU AI Act Article 12** — high-risk systems must "technically allow for the automatic recording of events (logs) over the lifetime of the system." Act **fully applicable 2 August 2026**. Penalty tiers (Art. 99(4)): €35M / 7% turnover for **prohibited** practices; €15M / 3% for **high-risk** non-compliance. _A finalized technical log-retention standard does not yet exist (drafts prEN 18229-1, ISO/IEC DIS 24970 incomplete) — do not hard-code a retention figure._
- **NIST AI RMF** — Govern / Map / Measure / Manage (voluntary; de facto for US procurement).
- **ISO/IEC 42001** — certifiable AI management system (increasingly in vendor questionnaires).
- **SOC 2** — CC6 / CC7 / CC8 control series.
- A single **cross-framework AI register + append-only trace store** typically satisfies the overlapping inventory/logging requirements. Have legal/compliance confirm jurisdiction and risk classification.

## Appendix C — Caveats (validate before depending)

- **Preview, not GA:** custom evaluators, Foundry hosted agents, the `ai-agent-evals` GitHub Action + Azure DevOps task, Purview-in-Foundry, and parts of the Control Plane. No SLA; can change.
- The Foundry Toolkit's declarative-workflow "visual builder" is largely a **VS Code for Web** experience from the Foundry portal — confirm hands-on whether it's a full in-editor desktop canvas.
- `VisualStudioCodeCredential` via `@azure/identity-vscode` is **Windows/Linux only (no macOS)** — prefer the VS Code Microsoft authentication provider for portability.
- Cost figures (e.g. "15–40% above token estimates", judge-token multipliers) are vendor/practitioner directional, not price sheets — confirm on Azure pricing pages.
- "One-click deploy" is marketing language; verify actual steps (ACR push, managed identity, role assignments) hands-on.
- The auto-discovery gap rests partly on **absence of evidence** that the Toolkit ingests `.claude`/`SKILL.md`/`AGENTS.md` — re-verify against the latest Toolkit release before committing roadmap.

## Appendix D — Flowchart generation prompt

> Create a clean, professional architecture flowchart suitable for a management presentation, of a platform called "**SDLC Agent Governance Platform**" — a VS Code extension plus an Azure AI Foundry governance/evaluation backend for managing AI agents across the software development lifecycle.
>
> **Layout:** horizontal swimlanes (stacked top to bottom), one per layer, color-coded. Left-to-right data flow within each lane; vertical arrows show calls between lanes. Use rounded rectangles for components, cylinders for stores, and diamonds for decision points. Label every arrow with what flows (e.g. "agent manifests", "eval request", "OTEL traces", "pass/fail gate").
>
> **Swimlanes (top to bottom), each a distinct color:**
>
> 1. **VS Code Extension (blue):** Extension Host (TypeScript); React Flow Webview (workflow visualizer/editor); Tree Views (Discovered Agents, Foundry Projects, Eval Results); Commands (Discover, Govern & Evaluate, Deploy to Foundry); Auth (VS Code Microsoft provider) and SecretStorage.
> 2. **Local Workspace (green):** Forked SDLC plugin; Agent/Skill manifests (.claude/agents, SKILL.md, AGENTS.md, agent.yaml); Discovery & Normalization Engine → Internal Agent Model → React Flow JSON → compiles to Microsoft Agent Framework YAML.
> 3. **Orchestration Runtime — server/Foundry-hosted (orange):** Microsoft Agent Framework (sequential/handoff/Magentic patterns); Master Orchestrator Policy Engine (evaluator gates, approvals, PII redaction, retries); Agent hand-off & state.
> 4. **Azure AI Foundry (purple):** Agent Service (name+version agents); Evaluators (built-in + custom); Foundry Control Plane (inventory, guardrail policies, compliance); AI Gateway.
> 5. **Audit / Storage / Governance (gray):** OpenTelemetry → Application Insights / Azure Monitor; Log Analytics / SIEM (append-only); Microsoft Purview (audit, DSPM, PII); Defender + Entra; CI/CD Eval Gate (GitHub Action / Azure DevOps).
> 6. **Future Sandbox (dashed teal):** Ephemeral microVM devcontainers; scoped Git tokens; deny-by-default egress; prompt-only UX; clone/branch/PR via GitHub/Azure DevOps APIs.
>
> **Decision diamonds to include:** "Framework detected?", "Manifest schema valid?", "Evaluator gate passed? (block PR on fail)", "Human approval required? (pause/resume)", "Run in editor or sandbox?".
>
> **Style:** minimal, lots of whitespace, consistent corner radius, a muted professional palette, a legend explaining shapes and the layer colors, and a short title block. Mark the "Future Sandbox" lane with a dashed border to indicate it's a later phase. Render as a top-down layered diagram.
