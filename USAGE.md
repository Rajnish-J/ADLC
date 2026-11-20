# SDLC Agent Governance — Usage Guide

A complete, end-to-end guide to using the **SDLC Agent Governance** VS Code extension: discovering
AI agents, evaluating and governing them, building workflows, and running a workflow conversationally
from **GitHub Copilot Chat** with `@sdlc` (including the issue-trigger → pick → live agent run flow).

> Looking for architecture/design rationale instead? See
> [SDLC_WORKFLOW_ORCHESTRATION.md](SDLC_WORKFLOW_ORCHESTRATION.md) and [docs/adr/](docs/adr/).

---

## 1. What this extension is

SDLC Agent Governance is a **control plane for AI agents across the software development lifecycle**.
It:

- **Discovers** agent manifests in your workspace (`.claude/agents`, `SKILL.md`, `AGENTS.md`,
  `agent.yaml`, Copilot instructions, Cursor rules) and normalizes them into one model.
- **Evaluates & governs** those agents against quality gates and content policies, backed by
  **Azure AI Foundry**, with an append-only **audit trail**.
- **Orchestrates** agents into **workflows** (a visual builder) and **runs** them with gates,
  approvals, and budgets.
- Provides an **`@sdlc` Copilot Chat participant** so you can start a workflow from an Azure DevOps
  work item and watch the agents complete it live in chat.

Everything is organized under a single **SDLC Governance** Activity Bar container with seven views.

---

## 2. Requirements

| Requirement | Why |
|---|---|
| **VS Code ≥ 1.90** | Chat (`@sdlc`) and Language Model APIs. |
| **GitHub Copilot Chat** (installed + signed in) | Provides the language model used to actually run agents (`dispatch.mode = lm`). Not needed in `mock` mode. |
| **Azure work account** | Microsoft sign-in for Foundry evaluation and Azure DevOps work-item lookups. |
| **Azure DevOps access** *(optional)* | Only for the **issue trigger** (assigned work items). |
| **Azure AI Foundry project** *(optional)* | Only for real evaluation/governance and the Control Plane. |

The core builder, discovery, and `mock` workflow runs work **without** any Azure or Copilot access.

---

## 3. Install & build

This is an unpackaged extension you run from source.

```bash
npm install
npm run build        # bundles dist/extension.js + the webview
```

Then press **F5** in VS Code to launch the **Extension Development Host** with the extension loaded.

Other useful scripts (see [package.json](package.json)):

| Script | Purpose |
|---|---|
| `npm run watch` | Rebuild on change. |
| `npm run typecheck` | Type-check extension + webview. |
| `npm run lint` | ESLint over `src`. |
| `npm test` | Build, compile tests, run the suite in a VS Code host. |
| `npm run package` | Produce a `.vsix` via `vsce`. |

---

## 4. First-time setup

1. Open the **SDLC Governance** icon in the Activity Bar (shield).
2. Run **`SDLC Governance: Sign in to Azure`** (command palette, the **SDLC** status-bar item, or the Agents
   view's `…` menu). This acquires both the management (ARM) and Foundry tokens so later calls are silent.
3. You'll see three views, each made of collapsible sections:

| View | Sections |
|---|---|
| **Stories** | Stories assigned to you, then each platform project with its **Project memory** (accepted items, plus proposals to accept or reject) and its stories. |
| **Agents** | **Project agents** (the platform catalog: built-in and codebase agents, enable/disable, where each is mapped) · **This workspace** (agents discovered in your files, with Evaluate / Govern) · **Evaluations** (gate evaluation runs and per-evaluator scores) · **Azure AI Foundry** (your Foundry projects and fleet **Compliance**). |
| **Workflows** | **Project workflows** (the platform's workflows, with the agent mapped to each step — **Change Agent…** to remap) · **Local workflows** (the SDLC default + your saved workflows) · **Runs** (live and historical runs; gate steps expand to their evaluator scores). |

The **SDLC** status-bar item shows Azure sign-in, platform connection, discovered-agent count and the last gate
result; click it for the account actions (it replaces the old Overview view).

---

## 5. Core concepts

- **Agent** — a normalized manifest (`name`, `description`, `instructions`, `tools`, `model`,
  `sourceKind`). Source conventions supported: Claude agents (`.claude/agents`), Claude skills
  (`SKILL.md`), `AGENTS.md`, `agent.yaml`, Copilot instructions, Cursor rules. Manifests are
  **parsed only — never executed**.
- **WorkflowSpec** — the version-controllable workflow definition (see
  [src/runtime/spec.ts](src/runtime/spec.ts)), persisted as `.sdlc/workflows/<id>.json`. Node kinds:

  | Kind | Role |
  |---|---|
  | `trigger` | The single start node (manual or **issue** trigger). |
  | `agent` | Invoke a discovered agent. |
  | `gate` | Enforce an SDLC quality gate (halt on fail). |
  | `approval` | Pause for a human decision. |
  | `condition` | `IF` / `ELSE_IF` / `ELSE` branching. |
  | `set-variable` | Assign a run-context variable. |
  | `goto` | Jump/loop to another node. |
  | `end` | Terminate the run. |

- **Run** — one execution of a spec, with append-only **steps**, a **budget** (max steps / time /
  tokens), and a **status** (`running`, `awaiting_approval`, `completed`, `failed`, `cancelled`).
- **Gate** — evaluates an agent's output for an SDLC step; a failing gate blocks the run.
- **Audit** — every gate decision and run step is recorded immutably for later inspection.

---

## 6. Discover agents

Discovery runs **automatically** on activation, on workspace changes, and on manifest edits
(debounced). To force a scan, run **`SDLC Governance: Discover Agents`** (search icon on the
**Agents › This workspace** section).

**Agents › This workspace** groups agents by source kind and shows name, description, source path,
model, and tools. Malformed manifests are surfaced in the **Problems** panel.

---

## 7. Evaluate & govern an agent

From **Agents › This workspace**, use the inline actions on an agent:

- **`SDLC Governance: Evaluate Agent`** — pick an SDLC step and a Foundry project; the agent is
  scored by the step's evaluators and a **gate decision** (pass/fail) is recorded. Results appear in
  **Agents › Evaluations** and the audit log
  (**`SDLC Governance: Open Evaluation Results`** opens the full report).
- **`SDLC Governance: Govern Agent`** — classifies content for PII/SIT (via Purview when enabled,
  else a local heuristic) and records the verdict.
- **`SDLC Governance: Govern & Evaluate`** — runs both.
- **`SDLC Governance: Scaffold ADO Eval Gate`** — generates an Azure Pipelines gate (YAML + README +
  dataset) so evaluation can run in CI on agent-manifest PRs.

---

## 8. Build a workflow

1. In the **Workflows** view, click **New Workflow** (title bar) or open the **SDLC Default**.
2. The **Workflow Builder** (canvas) opens:
   - **Node palette** (left) — drag node kinds onto the canvas (the `trigger` start node already
     exists in every workflow and is not in the palette).
   - **Canvas** — connect nodes by dragging between handles.
   - **Detail panel** (right) — select a node to configure it:
     - **Agent**: link a discovered agent, set the SDLC step and output variable.
     - **Gate**: set the gate step and result variable.
     - **Approval**: set the question and approval variable.
     - **Condition**: set branch (`IF`/`ELSE_IF`/`ELSE`) and predicate.
     - **Set Variable** / **Go To**: assignment / jump target.
     - **Trigger**: set **Trigger Type** and (for issue triggers) ADO details — see §9.
3. **Save** (toolbar) writes the spec to `.sdlc/workflows/<id>.json`. You can also right-click a
   `.sdlc/workflows/*.json` file → **Open Workflow Canvas** to view it.

Workflows view context actions: **Open Builder**, **Duplicate**, **Rename**, **Delete**
(the SDLC default cannot be renamed/deleted).

---

## 9. ★ Run a workflow with `@sdlc` (issue trigger → pick → live LLM run)

This is the headline flow: start a workflow from a work item assigned to you and watch the agents
complete it, all inside Copilot Chat.

### 9.1 Configure the start node as an Issue trigger

In the builder, select the **trigger** node and in the detail panel set:

- **Trigger Type** → **Issue (Azure DevOps work item)**
- **ADO Organization** and **ADO Project** — the `dev.azure.com/<org>` segment and project name.
- **Work Item Type** — defaults to `User Story`.
- **WIQL Override** *(optional)* — a custom query; otherwise the default is "assigned to me".

Org/project can instead be set globally via the settings
`sdlcGovernance.azureDevOps.organization` and `sdlcGovernance.azureDevOps.project`; the trigger-node
values take precedence. **Save** the workflow.

### 9.2 Run it from chat

1. Make sure **GitHub Copilot Chat** is installed and you're signed in to Azure.
2. Open the Copilot Chat panel and type:

   ```text
   @sdlc run <workflow name>
   ```

   (Or use the **Run Workflow in Chat (@sdlc)** button in the Workflows view title bar / the
   `SDLC Governance: Run Workflow in Chat` command. If you don't name a workflow, you'll be asked to
   pick one.)

3. What happens, in the same chat thread:
   - `@sdlc` resolves the workflow and reads its trigger.
   - For an **issue trigger**, it fetches the **work items assigned to you** in the configured
     org/project and **lists them in the chat**.
   - You **pick one** (quick pick). The work item's title, description, and acceptance criteria
     become the workflow's seed input.
   - The run starts; each **agent streams its output live** into the chat under a step heading.
   - **Approval** nodes pop a modal prompt — **Approve** continues the run, **Reject** stops it.
   - On completion you get a summary and an **Open run audit log** button.

The run also appears in the **Workflows › Runs** section and the run audit log, exactly like a non-chat run.

### 9.3 LLM vs mock dispatch

The setting **`sdlcGovernance.dispatch.mode`** controls how agents run:

- **`lm`** (default) — calls a real model via the VS Code Language Model API (GitHub Copilot). Each
  agent's `instructions` become its system prompt.
- **`mock`** — deterministic stub responses, no model needed (offline use / tests).

### 9.4 Workflow engine, restarts, cancel and gates

**Engine — `sdlcGovernance.runtime.engine`** (`langgraph` by default; changing it prompts for a window reload).

- **`langgraph`** runs the workflow on a real LangGraph state graph. The canvas shows each node as
  *running* the moment it starts (including while an agent is still writing its plan), then fills in its
  result. Runs are checkpointed, so **a run paused on a plan approval survives a window reload**: after the
  reload it reappears in **Workflows › Runs** and can be approved or rejected as usual.
- **`interpreter`** is the original in-memory engine. It has no durable store, so a paused run is lost on
  reload. Keep it as a fallback if you hit a LangGraph problem.

**Restart behaviour (`langgraph`)**

- A run found paused after a reload is restored with its plan. Runs paused for more than **14 days** are
  discarded instead of restored.
- A run that was in the middle of a step when the window closed cannot be resumed mid-step. It is shown
  once as **failed** ("interrupted by an extension restart") and recorded in the run audit log.
- Finished runs (completed, failed or cancelled) are removed from the checkpoint store when they end, so
  the storage files stay small. Their history stays in the run audit log.

**Cancel** stops an in-flight run: it tells the running agent's model request to stop, marks the run
**cancelled**, and removes its checkpoint so it cannot come back after a reload. Steps that were still
running are shown as *skipped*.

**Gates — `sdlcGovernance.gate.evaluator`.** The check after each agent step has three modes:

| Mode | Behaviour |
|---|---|
| `auto` (default) | Evaluate with Foundry when you are signed in **and** `gate.projectEndpoint` is set. Otherwise use the offline stub, **say so once**, and label every stub verdict `[offline stub gate …]` in the audit trail. Never prompts. |
| `foundry` | Always evaluate with Foundry. The first gate asks you to pick a project and saves it to `gate.projectEndpoint`. If an evaluation cannot run, the step is **blocked** (`eval.failClosedOnError`, default) or passed (fail-open). |
| `stub` | Offline stub only: it checks the output for the word "fail". For demos — **not** a governance check. |

How a real gate decides: it sends the step's output (and the run's task) to the Foundry evaluators listed for
that SDLC step, then applies the thresholds from the gate policy. Safety evaluators such as violence are
*lower-is-better* (a severity above the threshold blocks). Evaluators that need tool-call data, such as
`tool_call_accuracy`, **cannot run on an in-run gate** and are skipped; the skip is listed in the gate
decision so it is visible rather than silent. Each real evaluation is written to **Agents › Evaluations**, the
audit store and (if enabled) Log Analytics and App Insights.

---

## 10. Run a workflow without chat

Prefer the command palette? **`SDLC Governance: Run Workflow`**:

1. Pick the agents to chain (top-to-bottom order).
2. Choose an approval mode (none / before the final agent / before each agent).
3. Enter a task to seed the first agent.

The run starts and is shown in the **Workflows › Runs** section. Inline actions there:

- **Approve Run** / **Reject Run** — resolve a paused approval.
- **Cancel Run** — stop an active/paused run.
- **Open Workflow Canvas** — visualize the run on the canvas with a live overlay.
- **Open Run Audit Log** — view the append-only run audit.

---

## 11. Compliance, Continuous Eval & Purview

- **Agents › Azure AI Foundry › Compliance** section — lists compliant vs non-compliant agents against guardrail
  policies. Inline **Remediate Agent**, or **Remediate All Non-Compliant Agents** (both confirm
  before fleet writes). Refresh with **`SDLC Governance: Refresh Control Plane`**.
- **Continuous evaluation** — **`SDLC Governance: Run Continuous Evaluation`** re-scores a sample of
  recent runs and raises quality/spend alerts; **`Open Continuous-Eval Alert Log`** shows them.
  Configured under `sdlcGovernance.continuousEval.*`.
- **Purview classification** — **`SDLC Governance: Classify Content for PII/SIT`** classifies the
  current selection/input (Purview when enabled, else a local heuristic).

---

## 12. Settings reference

All settings live under the `sdlcGovernance.*` namespace (Settings UI → "SDLC Agent Governance").

| Setting | Default | Purpose |
|---|---|---|
| `dispatch.mode` | `lm` | How agents run: `lm` (real model via Copilot) or `mock` (stub). |
| `runtime.engine` | `langgraph` | Workflow engine: `langgraph` (durable, live per-step progress) or `interpreter` (in-memory). Needs a window reload. |
| `gate.evaluator` | `auto` | How gates decide: `auto` (Foundry when configured, else offline stub), `foundry`, or `stub`. See §9.4. |
| `gate.projectEndpoint` | `""` | Foundry project endpoint that evaluates gates. Filled in by a picker the first time a gate runs in `foundry` mode. |
| `azureDevOps.organization` | `""` | Default ADO org for issue-trigger lookups (overridden per trigger node). |
| `azureDevOps.project` | `""` | Default ADO project for issue-trigger lookups (overridden per trigger node). |
| `eval.judgeDeployment` | `gpt-4o` | Azure OpenAI deployment used as the judge model. |
| `eval.transport` | `sdk` | Foundry evals transport: `sdk` or `fetch`. |
| `eval.pollIntervalMs` | `5000` | Poll interval while awaiting an evaluation run. |
| `eval.pollTimeoutMs` | `600000` | Max wait for an evaluation run. |
| `eval.failClosedOnError` | `true` | Treat an errored/missing evaluator as a gate failure. |
| `eval.customEvaluators` | `false` | Register/run preview custom evaluators. |
| `eval.sampling` | `{strategy:"ratio",ratio:0.25,minRows:5}` | Dataset sampling to bound eval cost. |
| `gate.defaultThresholds` | `{}` | Fallback per-evaluator thresholds. |
| `telemetry.enabled` | `false` | Emit OpenTelemetry GenAI spans to App Insights. |
| `telemetry.recordContent` | `false` | Include prompt/completion content on spans (PII — off by default). |
| `telemetry.appInsightsConnectionString` | `""` | App Insights connection string (prefer storing as a secret). |
| `audit.logAnalytics.enabled` | `false` | Mirror audit records to Log Analytics. |
| `audit.logAnalytics.dcrEndpoint` | `""` | Data Collection Rule ingestion endpoint. |
| `audit.logAnalytics.dcrImmutableId` | `""` | Immutable id of the DCR. |
| `audit.logAnalytics.streamName` | `""` | Custom table stream name. |
| `continuousEval.enabled` | `false` | Periodically sample recent runs and alert on regressions/spend. |
| `continuousEval.sampleRate` | `0.25` | Fraction of recent runs to re-score per cycle. |
| `continuousEval.minSamples` | `5` | Floor on runs sampled per cycle. |
| `continuousEval.alertThreshold` | `0.7` | Score below this raises a quality alert. |
| `continuousEval.evalSpendBudgetRatio` | `0.15` | Alert when eval tokens exceed this fraction of inference tokens. |
| `purview.enabled` | `false` | Classify content via Microsoft Purview (preview); else local heuristic. |
| `purview.endpoint` | `""` | Purview DSPM-for-AI endpoint. |

---

## 13. Commands reference

All under the **SDLC Governance** category (command palette: type "SDLC Governance").

| Command | What it does |
|---|---|
| Show Status | Print activation/sign-in status. |
| Sign in to Azure / Sign out of Azure | Manage the Microsoft session. |
| Clear Stored Connection | Clear cached connection secrets. |
| Discover Agents | Re-scan the workspace for agent manifests. |
| Evaluate Agent | Score an agent against an SDLC gate. |
| Govern Agent | Classify an agent's content for PII/SIT. |
| Govern & Evaluate | Run governance + evaluation together. |
| Scaffold ADO Eval Gate | Generate an Azure Pipelines evaluation gate. |
| Open Evaluation Results | Open the full evaluation report. |
| Run Workflow | Compose + run a workflow via quick picks. |
| **Run Workflow in Chat (@sdlc)** | Open Copilot Chat to run a workflow conversationally. |
| Approve Run / Reject Run / Cancel Run | Resolve or stop a run. |
| Open Workflow Canvas | Visualize a run/spec on the canvas. |
| Open Run Audit Log | Open the append-only run audit. |
| Open Workflow Builder / New / Duplicate / Rename / Delete Workflow | Manage workflows. |
| Refresh Foundry Projects | Re-list accessible Foundry projects. |
| Refresh Control Plane | Re-fetch fleet compliance. |
| Remediate Agent / Remediate All Non-Compliant Agents | Apply guardrail policy. |
| Run Continuous Evaluation / Open Continuous-Eval Alert Log | Quality/spend monitoring. |
| Classify Content for PII/SIT | Classify selected content. |

---

## 14. Troubleshooting

- **"No language model is available"** — install and enable **GitHub Copilot Chat** and sign in, or
  set `sdlcGovernance.dispatch.mode` to `mock` to run without a model.
- **Issue trigger shows no items / 401** — confirm you're **signed in to Azure**, the work items are
  actually **assigned to you**, and the **org/project** are correct (on the trigger node or in
  settings). The account must have access to that Azure DevOps organization.
- **"Open a workspace folder first"** — workflows are stored in `.sdlc/workflows`; open a folder.
- **No Foundry projects listed** — sign in, and ensure your account has RBAC access; the view
  silently skips subscriptions/resource groups you can't read.
- **`@sdlc` not found in chat** — ensure the Extension Development Host is running this extension and
  Copilot Chat is installed (the participant is contributed via `chatParticipants`).

---

## 15. Further reading

- [SDLC_WORKFLOW_ORCHESTRATION.md](SDLC_WORKFLOW_ORCHESTRATION.md) — the phased product plan.
- [BUILD_VS_BUY.md](BUILD_VS_BUY.md) — build-vs-buy rationale.
- [docs/adr/](docs/adr/) — architecture decision records.
- Key source: [src/extension.ts](src/extension.ts),
  [src/runtime/spec.ts](src/runtime/spec.ts),
  [src/chat/workflowChatParticipant.ts](src/chat/workflowChatParticipant.ts),
  [src/integrations/azureDevOps/adoClient.ts](src/integrations/azureDevOps/adoClient.ts),
  [src/runtime/dispatch/lmAgentDispatcher.ts](src/runtime/dispatch/lmAgentDispatcher.ts).
