# Orchestrator service

Python (FastAPI + LangGraph). It owns two things:

- **The catalog:** workflows (create, edit, validate, set as default, delete, map an agent / skills / a harness onto a step) and agents & skills (list, enable, platform-defined CRUD).
- **Platform runs:** request, claim, cancel, approvals, activity, expiry. It also drives every run's workflow.

The gateway ([`apps/api`](../../apps/api)) handles sign-in and forwards these calls. The web app and the extension never talk to this service directly. Decision record: [ADR 0004](../../docs/adr/0004-python-orchestrator-service.md).

## How a run executes

1. **The workflow becomes a graph.** The run's workflow (`runs.spec_snapshot`) is compiled into a LangGraph `StateGraph` (`app/engine/compiler.py`).
   - Every node a user puts on the canvas becomes LangGraph node(s).
   - Conditions become conditional edges, and goto becomes a cycle.
   - The graph is checkpointed by `AsyncPostgresSaver` in the `orchestrator` schema, with thread id = run id.
2. **Agent steps go to a harness.** An agent step is not run on the server. It is handed to a harness (Copilot, Claude Code, Codex, …) in the user's VS Code: the step's pinned `data.harness`, or else the run's harness.
   - The step expands to `__plan_req → __plan_wait → __approve → __exec_req → __exec_wait`.
   - `_req` nodes record a `step_assignments` row. `_wait` nodes only call `interrupt()`, so nothing is parked in memory between steps.
3. **The harness works the step.** It calls the SDLC tools in VS Code, which reach this service through the gateway:
   - `sdlc_next_step` → `GET …/runs/:id/steps/next`, a long-poll that returns the step, `waiting`, `handoff`, or `done`/`stopped`.
   - `sdlc_submit_plan` → `POST …/steps/:stepId/plan`.
   - `sdlc_complete_step` → `POST …/steps/:stepId/complete`.

   Each answer resumes the graph with `Command(resume={interrupt_id: value})`.
4. **A person approves.** Human approvals (`POST …/runs/:id/approval`) resume the `__approve` / approval interrupts.
5. **State reaches the clients.** The graph state is mirrored into `runs` / `run_steps`, so the existing run views read it unchanged. Changes go out with `pg_notify('sdlc_events', …)`, which the gateway relays to SSE.
6. **The run finishes.** On a terminal state the checkpoint thread is deleted and the gateway captures run memory (`POST /internal/runs/:id/finished`).

Parallel branches advance superstep by superstep, which is LangGraph's model: a branch waits at each step until its sibling reaches the same point.

**The sweeper** (`app/engine/sweeper.py`) runs every 30 s and:
- expires unclaimed requests;
- starts claimed runs whose graph never started;
- resumes a step whose result was recorded but not yet applied;
- continues a run from its last checkpoint after a crash;
- re-announces steps no harness picked up;
- fails runs that are over their time budget (240 minutes of work by default; time waiting on a person doesn't count).

## Layout

| Path | What it does |
|---|---|
| `app/main.py`, `app/serve.py` | The FastAPI app and its runner (a selector event loop on Windows, which psycopg needs) |
| `app/security.py`, `app/access.py`, `app/rbac.py` (+ generated `rbac.json`) | Internal token, the caller, and project access. Same rules as `@sdlc/contracts` |
| `app/db/tables.py` | SQLAlchemy Core mirrors of the platform tables. **Drizzle owns the schema and migrations**; this service never migrates |
| `app/spec/` | The `WorkflowSpec` model and `validate_workflow_spec`. Same messages as `@sdlc/core` |
| `app/engine/` | Conditions, run variables, budget guards, graph helpers (ports of the extension's runtime), plus the compiler, runner and sweeper |
| `app/catalog/` | Workflows, step agent / skills / harness, agents & skills |
| `app/runs/`, `app/harness/` | Run lifecycle and harness step assignments |
| `app/gates/` | The in-run gate. A labelled stub until a server-side evaluator is configured |

## Run and test

```sh
npm run dev:orchestrator    # from the repo root: http://127.0.0.1:4100, reloads on change
npm run start:orchestrator  # without reload
npm run test:orchestrator   # pytest (DB tests need `npm run db:up && npm run db:migrate && npm run db:seed`)
npm run check:orchestrator  # ruff, ruff format --check, mypy
```

Settings come from the environment or the repo-root `.env` (see `.env.example`):

| Setting | Default | What it is |
|---|---|---|
| `DATABASE_URL` | | The platform database |
| `ORCHESTRATOR_TOKEN` | | Shared with the gateway. Required in production |
| `ORCHESTRATOR_HOST` / `ORCHESTRATOR_PORT` | `127.0.0.1:4100` | Where the service listens |
| `API_URL` | | The gateway, for callbacks |
| `RUN_TIMEOUT_MINUTES` | 240 | A run's time budget |

After changing roles or permissions in `packages/contracts/src/rbac.ts`, run `npm run emit:rbac -w @sdlc/contracts`.
