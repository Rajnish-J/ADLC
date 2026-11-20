# ADR 0004: A Python orchestrator service drives platform runs; each step runs in its own harness

- **Status:** Accepted
- **Date:** 2026-11-17
- **Relates to:**
  - ADR 0001: settles its open question of *where* governed runs execute.
  - ADR 0003: LangGraph.js stays in the extension, but only for local runs.

## Context

The platform backend was a single TypeScript service (`apps/api`, Fastify). It stored workflow specs and recorded what the VS Code extension reported, but it never executed a workflow. The extension compiled each workflow into a LangGraph.js graph and ran all of it locally. It handed every agent step to **one** harness chat per run, and approvals could only be given in VS Code. The roadmap had always said governed runs should execute on a server-side runtime (`SDLC_WORKFLOW_ORCHESTRATION.md`, the L4 layer), and the schema already reserved `runs.origin = 'server'`.

We wanted three things:
1. The core workflow logic in a Python FastAPI backend.
2. Every node a user builds runs as a LangGraph node.
3. The agent bound to each node runs in the user's connected harness (Copilot, Claude Code, Codex). Different steps may use different harnesses.

## Decision

- **New service.** `services/orchestrator` (Python 3.12+, FastAPI, LangGraph, psycopg 3, SQLAlchemy Core) owns:
  - **The catalog:** workflows, agents & skills, and step agent / skills / **harness** mappings.
  - **The run lifecycle:** request, claim, cancel, approvals, activity, expiry.
  - **The engine:** it compiles a spec into a LangGraph `StateGraph` checkpointed by `AsyncPostgresSaver`, in its own `orchestrator` schema.
- **Every external wait is an `interrupt()`.** That covers a harness's plan, a harness's result and a human decision. An agent step is `_req` / `_wait` node pairs around a human `__approve`, so replaying a node on resume has no side effects (the ADR 0003 pattern).
  - Nothing is held in memory between steps.
  - A restart resumes from the checkpoint, and a sweeper recovers runs whose process died mid-step.
- **Per-node harness.** `SpecNodeData.harness` pins an agent step to a harness; unpinned steps use the run's harness.
  - A run starts only if one online VS Code window has every harness it needs and the project allows them all. Otherwise it fails with a 409 `missing_harnesses`.
  - The extension opens each harness when its first step arrives (`run.step` event). A harness told `handoff` ends its turn.
- **`apps/api` becomes the gateway.** It keeps sign-in, projects, stories, memory, repositories, boards, chat, local-run reports and SSE.
  - Its `services/{workflows,agents,sessions,stepSkills}.ts` are facades with unchanged signatures that call the orchestrator over HTTP with a shared internal token and the user's id. The orchestrator re-checks project access with the same RBAC rules (generated `rbac.json`).
  - Errors come back as the same `HttpError`s, so the routes and the chat assistant's tools behave as before.
  - Orchestrator events arrive through `LISTEN sdlc_events` and go out on SSE.
- **One database, one migration owner.** Drizzle stays the only migration owner. Migration 0014 adds:
  - `runs.driver` and `runs.spec_snapshot`
  - `run_steps.engine`
  - `step_assignments`
  - the `orchestrator` schema

  The Python service mirrors the tables it uses (`app/db/tables.py`), and a parity test checks them against the database.
- **Local mode stays.** Runs on the extension's built-in runtime, and runs while signed out, still use LangGraph.js inside VS Code.
- **Approvals.** They can be given on the web (`POST …/runs/:id/approval`) and from a VS Code notification.

## Consequences

**Positive:**
- Runs are governed on the server: durable, restartable, auditable in one place.
- Each step can use the harness best suited to it.
- Approvals work from the web.
- The service split follows the domain: catalog and execution in Python, everything else in the gateway.
- `runs.origin` / `driver` now mean what they say.

**Negative / risks:**
- Two languages share one database, and some logic exists twice:
  - spec validation, conditions and guards in TypeScript (extension local mode) and Python;
  - RBAC rules, generated from TypeScript.

  Ports were made message-for-message and are pinned by tests (the `rbac.json` drift test, the schema parity test, and the ported unit cases). Shared cross-engine fixtures are a follow-up.
- **Parallel branches advance superstep by superstep** (LangGraph semantics): a branch's next step waits for its sibling's current step.
- **The in-run gate is a labelled stub on the server** until a server-side evaluator (`azure-ai-evaluation` / Foundry, with service credentials) is configured. The extension's Foundry gate used the developer's own Azure sign-in.
- **The gateway and the orchestrator call each other**: the gateway forwards requests, and the orchestrator calls back when a run finishes. Both directions need the shared token.
- **Not deployed yet.** CI still builds only the extension. Adding a Python stage and deploying the service are separate, approved changes.

**Follow-ups:**
- A server-side gate evaluator.
- Shared engine parity fixtures.
- A full web workflow builder.
- Moving further domains behind the gateway into Python if wanted.
- A CI stage and a deployment target for the service.
