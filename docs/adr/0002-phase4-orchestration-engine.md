# ADR 0002 — Phase 4 orchestration engine

- **Status:** Superseded by [ADR 0003](0003-langgraph-orchestration-engine.md). The P4.0 spike below was never run, and Foundry declarative workflows retire on 2026-12-01 (see `BUILD_VS_BUY.md`, row 8). Kept for history.
- **Date:** _fill on decision_
- **Supersedes / relates to:** ADR 0001 (deferred orchestration framework + host location to Phase 4)

## Context

Phase 4 executes multi-agent SDLC workflows on a host (never the editor) with an in-run governance gate.
Planning selected a **hybrid** approach: Foundry runs the workflow **declaratively**; the eval-gate /
redaction / budget policy stays **TypeScript** (reusing Phase-3 `decideGate`), invoked from the workflow.

Key facts established during planning (verified on Microsoft Learn, 2026-06):
- "MAF" has no TypeScript SDK (C#/Python only; declarative packages are **prerelease**).
- "Foundry declarative workflows" = MAF expressed as YAML; the dialect matches this repo's harvested
  `orka/workflow-yaml.ts` (with corrections: `kind: Workflow` + nested `trigger.actions[]`; `GotoAction`/
  `actionId`; HITL via `Question`/`RequestExternalInput`, not `SendMessage`).
- `HttpRequestAction` is first-class → a workflow can call our TS gate endpoint directly (no C# required).

The hybrid rests on two unknowns the docs do **not** settle, which the P4.0 spike must resolve.

## Spike findings (P4.0)

> Fill in from `spike/phase4-orchestration/`.

- **Unknown A — execution surface:** ☐ A1 Foundry runs the YAML server-side via REST/portal (all-TS holds)
  / ☐ A2 declarative workflows run **in-process via the prerelease SDK only** (host needs a Python/C# runner).
  - Working endpoints + `api-version`: _____
- **Unknown B — HITL over the chosen surface:** how `Question` pauses + resumes: _____
- **Unknown C — accepted YAML flavor:** ☐ C# (`kind: Workflow`) / ☐ Python (`name:` + `actions:`).
- **HTTP gate halt-on-fail worked:** ☐ yes / ☐ no — notes: _____
- **Agent registration by name+version:** _____

## Decision

> One of:
- **Hybrid as planned (A1 + HTTP gate):** Foundry-operated declarative engine; TS gate endpoint (P4.3);
  thin TS run-lifecycle client (P4.4). No C#.
- **A2 in-process:** operate a minimal **Python/C# SDK runner** as the host. Re-confirm with the user — this
  reintroduces a language split and may favor the C#-hosted-agent gate or porting the orka executor instead.
- **Other:** _____

## Consequences

- _Positive:_ _____
- _Negative / risks:_ preview/prerelease packages; YAML schema drift (centralize emitters in `specToYaml.ts`).
- _Follow-ups:_ unblocks P4.1 (shared core) → P4.2 (compiler) → P4.3/P4.4 → P4.5 (patterns).
