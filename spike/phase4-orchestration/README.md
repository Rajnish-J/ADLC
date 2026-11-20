# P4.0 — Hybrid orchestration spike

> **Status:** artifacts scaffolded; **must be run by a human against a live Foundry project.** This spike
> gates all other Phase 4 work (see the plan: `~/.claude/plans/sdlc-workflow-orchestration-md-plan-for-kind-pearl.md`).
> Until it passes, do **not** start the compiler (P4.2), host (P4.3), or run-client (P4.4).

## Why this spike exists

The Phase 4 plan picked a **hybrid** engine: Foundry runs an SDLC workflow *declaratively*, while the in-run
governance gate stays **TypeScript** (reusing Phase-3 `decideGate`). That hinges on assumptions the Microsoft
Learn docs only *partially* confirm. We verified the declarative action schema from
[Declarative Workflows — Overview](https://learn.microsoft.com/agent-framework/workflows/declarative); the
items below are what the docs do **not** settle and the spike must.

## What the docs already confirmed (no need to re-verify)

- `HttpRequestAction` is a first-class declarative action (`url`, `method`, `headers`, `body: {kind: json}`,
  `response: <var>`, `requestTimeoutInMilliseconds`). **A declarative workflow can call our TS gate endpoint
  directly over HTTP** — no Foundry agent/tool wrapper, no C#. Branch on the result with `ConditionGroup`/`If`.
- `InvokeAzureAgent` references agents by **`agent.name`** (no `version` field in the YAML — versioning is at
  registration time). Output captured via `output.responseObject: Local.X`.
- HITL actions are **`Question`** (`question.text` / `variable` / `default`) and **`RequestExternalInput`**
  (`prompt.text` / `variable` / `default`) — **not** orka's `SendMessage`/`waitForResponse`.
- Control flow: `ConditionGroup` (`conditions[].condition` + `.actions`, `elseActions`), `If` (`condition`/
  `then`/`else`), `GotoAction` (`actionId`). Expressions use the `=` prefix; `And/Or/Not`, `Concat`, `If`,
  `IsBlank`; operators `= <> < > <= >=`.
- All declarative packages are **prerelease** (`Microsoft.Agents.AI.Workflows.Declarative --prerelease`;
  `pip install agent-framework-declarative --pre`).

## The three things to PROVE (plan's exit gate for P4.0)

1. **TS-callable gate over HTTP.** A declarative workflow invokes our TypeScript gate endpoint via
   `HttpRequestAction`, stores the JSON result in `Local.GateResult`, and **halts on fail** via a
   `ConditionGroup`/`If` on `=Local.GateResult.pass`. → If this works, **no C# gate-agent is needed.**
2. **HITL pause/resume.** A `Question` (or `RequestExternalInput`) node pauses the run awaiting human input,
   and the run resumes on response — **observable through whatever execution surface we'll actually use** (see
   Unknown A).
3. **Run lifecycle verbs.** start / poll-status / cancel behave as documented; **capture the exact endpoints
   + api-version** that work for *this* project.

## The unknowns the docs did NOT settle (resolve these first — they can invalidate the architecture)

- **Unknown A — execution surface.** The docs only show declarative workflows executed **in-process via the
  prerelease SDK** (`WorkflowFactory.create_workflow_from_yaml_path(...).run()` in Python;
  `DeclarativeWorkflowBuilder.Build(...)` + `InProcessExecution.RunStreamingAsync` in C#). They show **no REST
  API to register a YAML workflow into the Foundry service and run it server-side.** The Foundry portal has a
  visual builder + low-code YAML editor, but that is authoring, not necessarily a headless run API.
  **Determine which is true for our project:**
  - (A1) Foundry service ingests/runs the workflow YAML server-side via REST/portal → the extension is a thin
    REST client (the plan's assumption holds, all-TS).
  - (A2) Declarative workflows only run **in-process via the SDK** → we must operate a small **Python or C#
    runner** as the host (reintroduces a language split). If so, reconsider vs. the C#-hosted-agent fallback,
    or vs. porting the orka executor after all. **Record the finding in the ADR.**
- **Unknown B — how HITL surfaces remotely.** `Question` raises an in-process `RequestInfoEvent`. If execution
  is server-side (A1), confirm whether the *run* exposes a `requires_action`-style state over REST that we can
  poll + respond to (analogous to function-calling's `submit_tool_outputs`). If only in-process (A2), pause/
  resume is an SDK-runner concern.
- **Unknown C — workflow flavor.** C# uses `kind: Workflow` + nested `trigger.actions[]`; Python uses top-level
  `name:` + `actions:`. Confirm which flavor *our* execution surface accepts. Two skeletons are provided.

## Files in this spike

| File | Purpose |
| --- | --- |
| `workflow.gate-hitl.csharp.yaml` | Hand-authored workflow, **C# flavor** (`kind: Workflow` + `trigger`). 2 agents → HTTP gate → ConditionGroup halt-on-fail → Question HITL. |
| `workflow.gate-hitl.python.yaml` | Same workflow, **Python flavor** (`name:` + top-level `actions:`). Try whichever the surface accepts (Unknown C). |
| `gate-endpoint/server.mjs` | Zero-dependency Node HTTP stub of the TS gate endpoint. Mimics the P4.3 contract: `POST /gate` → `{ pass, reason, perEvaluator }`. Run locally, expose via a tunnel for `HttpRequestAction`. |
| `run-spike.mjs` | Operator runner skeleton: reads env, exercises the run lifecycle (start/poll/cancel) and prints results. **Has explicit TODO markers** where the operator confirms the real API per Unknown A. |

## How to run

```pwsh
# 1. Start the gate stub (returns pass/fail; flip with a query flag to test halt-on-fail)
node spike/phase4-orchestration/gate-endpoint/server.mjs        # listens on http://localhost:7071/gate
#    Expose it so Foundry can reach it (pick one): dev tunnel, ngrok, or deploy the stub.
#    Put the public URL into the workflow YAML's HttpRequestAction.url.

# 2. Author/register the two member agents + the workflow in your Foundry project
#    (portal visual builder, or VS Code low-code YAML editor, or SDK — per Unknown A).

# 3. Drive a run. Sign-in token via the extension's Phase-1 auth, or:
$env:FOUNDRY_TOKEN = az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<your-project>.services.ai.azure.com/api/projects/<name>"
node spike/phase4-orchestration/run-spike.mjs
```

## What to capture (feeds the ADR)

- Which **Unknown A** branch is real (A1 server-side REST vs A2 in-process SDK), with the exact
  endpoints + `api-version` used.
- Whether **halt-on-fail** worked: gate stub returns `pass:false` → run ends without invoking the second agent.
- Whether the **Question** node paused and resumed, and how that surfaced (REST field / SDK event).
- Which **YAML flavor** the surface accepted.
- Any schema rejections (action `kind`, property names) — these refine the P4.2 compiler emitter.

## Decision

Write the outcome to `docs/adr/0002-phase4-orchestration-engine.md`:
- **Pass (A1 + HTTP gate works):** proceed with the all-TS hybrid as planned.
- **A2 (in-process only):** decide between (i) a minimal Python/C# SDK runner host, (ii) the C# hosted-agent
  gate fallback, or (iii) porting the orka executor. Re-confirm with the user before P4.2.
