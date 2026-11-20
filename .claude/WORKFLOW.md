# Developer Workflow Guide

This guide maps every phase of the software development lifecycle to the skills and agents in this project. Follow phases in order for a new feature, or jump to the phase you need.

**How to invoke a skill:** Say the trigger phrase in conversation — Claude picks it up automatically.
**How to invoke an agent:** Say the trigger phrase; Claude spawns a focused sub-agent for that task.

---

## Workflow Overview

```
Phase 1: Discovery
  └─ requirements-gathering · user-journey-mapping · brd-template
  └─ Agents: requirements-analyst · brd-generator · gap-analyzer
        │
        ▼
Phase 2: Design
  └─ hld-template · lld-template · api-design-patterns · db-schema-design · architecture-decision-record
  └─ Agents: hld-architect · api-contract-designer · db-schema-designer · adr-writer · tech-spike-researcher
        │
        ▼
Phase 3: Azure Planning
  └─ azure-user-story-creation · azure-sprint-planning · task-analyzer
  └─ Agents: user-story-writer · sprint-planner · feature-prioritizer
        │
        ▼
Phase 4: Implementation
  └─ plan-first-instruction · nextjs-api-route-scaffold · nextjs-service-layer
  └─ nextjs-middleware-scaffold · shadcn-component-integration · nextjs-hooks-pattern
  └─ Agents: api-route-builder · service-layer-designer · auth-guard · component-scaffolder · api-integrator · error-handler
        │
        ▼
Phase 5: Testing & Quality
  └─ test-strategy-planning · unit-test-patterns · e2e-testing-setup · build-lint-check · ai-code-review
  └─ Agents: test-planner · test-writer · e2e-test-agent · coverage-analyzer · code-reviewer
        │
        ▼
Phase 6: Git & PR
  └─ git-branch-workflow · feature-commit · commit-message-formatter
  └─ git-pr-preparation · pr-description-generator · pr-raise · code-review-checklist
  └─ Agents: pr-reviewer
        │
        ▼
Phase 7: Deployment
  └─ build-lint-check · rollback-helper
  └─ Agents: security-scanner · pipeline-builder · deployment-manager · rollback-handler
```

---

## Phase 1: Discovery & Requirements

**Goal:** Understand what needs to be built before writing code. Produce a documented requirements set and BRD.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 1.1 | Skill | `requirements-gathering` | "gather requirements" / "requirements session" / "discovery phase" | Structured requirements with stakeholder interview template | Step 1.2 |
| 1.2 | Agent | `requirements-analyst` | "analyse requirements" / "extract requirements" / "what are the requirements here" | Functional & non-functional requirements table, gaps list | Step 1.3 |
| 1.3 | Skill | `user-journey-mapping` | "user journey" / "map the user flow" | Journey map with touchpoints and pain points | Step 1.4 |
| 1.4 | Skill | `acceptance-criteria-writer` | "write acceptance criteria" / "define AC" | Gherkin-style acceptance criteria per story | Phase 3 (stories) |
| 1.5 | Skill | `brd-template` | "write BRD" / "document business requirements" | Business Requirements Document skeleton | Phase 2 |
| 1.5a | Agent | `brd-generator` | "generate requirements document" / "create BRD" | Complete, fully-populated BRD | Phase 2 |
| 1.6 | Agent | `gap-analyzer` | "find gaps in requirements" / "review BRD" | Gap list, contradictions, missing info | Back to 1.5 |
| 1.7 | Skill | `change-request-analysis` | "analyse this change request" / "CR impact" | CR impact assessment with scope, risk, effort | Phase 2 or Phase 3 |
| 1.8 | Agent | `stakeholder-reporter` | "stakeholder report" / "executive summary" | Business-language status report for stakeholders | — |

**Chain:**
```
Stakeholder brief
  → requirements-gathering (skill)
  → requirements-analyst (agent)  ← outputs requirements table
  → acceptance-criteria-writer (skill)
  → brd-generator (agent)         ← outputs complete BRD
  → gap-analyzer (agent)          ← outputs gap list
  ↓
Phase 2: Design
```

---

## Phase 2: Design & Architecture

**Goal:** Translate requirements into architecture decisions, system design, API contracts, and DB schema before implementation begins.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 2.1 | Skill | `hld-template` | "HLD" / "high-level design" / "system architecture" | HLD document with component breakdown, data flow | Step 2.2, Phase 4 |
| 2.1a | Agent | `hld-architect` | "create HLD" / "design the architecture" / "architect this feature" | Full HLD with diagrams, integrations, decisions | Phase 4 |
| 2.2 | Skill | `lld-template` | "LLD" / "low-level design" / "detailed design" | LLD with class/function breakdown, pseudocode | Phase 4 |
| 2.3 | Skill | `api-design-patterns` | "API design" / "REST patterns" / "design the endpoints" | API contract reference with verbs, status codes, patterns | Step 2.3a |
| 2.3a | Agent | `api-contract-designer` | "design API contract" / "API specification" / "define endpoints" | Full OpenAPI-style contract for the feature | Phase 4 (implementation) |
| 2.4 | Skill | `db-schema-design` | "design the schema" / "what tables do I need" | Drizzle ORM schema with columns, indexes, FK constraints | Phase 4 (DB) |
| 2.4a | Agent | `db-schema-designer` | "design database schema" / "DB design" / "create Drizzle schema" | Normalised Drizzle schema with relations and types | Phase 4 (DB) |
| 2.5 | Skill | `architecture-decision-record` | "write ADR" / "document this decision" | ADR with context, options, decision, consequences | Codebase docs |
| 2.5a | Agent | `adr-writer` | "write ADR" / "create architecture decision record" | Complete ADR file | Codebase docs |
| 2.6 | Agent | `tech-spike-researcher` | "tech spike" / "research this library" / "evaluate options for" | Recommendation with pros/cons, effort, prototype plan | Step 2.5a |

**Chain:**
```
BRD (from Phase 1)
  → hld-architect (agent)          ← outputs HLD
  → api-contract-designer (agent)  ← outputs API contract
  → db-schema-designer (agent)     ← outputs Drizzle schema
  → adr-writer (agent)             ← documents key decisions
  ↓
Phase 3: Azure Planning
```

---

## Phase 3: Azure DevOps Planning

**Goal:** Translate design artifacts into tracked work items, sprint plan, and team assignments in Azure DevOps.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 3.1 | Agent | `feature-prioritizer` | "prioritise features" / "what should we build first" / "rank these features" | MoSCoW or RICE-scored feature list | Step 3.2 |
| 3.2 | Skill | `azure-user-story-creation` | "create user stories" / "stories in Azure" | User story template with fields for Azure | Step 3.2a |
| 3.2a | Agent | `user-story-writer` | "write user stories for this feature" / "create stories in Azure" | Complete user stories with AC, created in Azure DevOps | Step 3.3 |
| 3.3 | Skill | `task-analyzer` | "analyse this task" / "break down the work" | Task breakdown with effort estimate | Step 3.4 |
| 3.4 | Skill | `azure-sprint-planning` | "plan the sprint" / "sprint planning" | Sprint plan with capacity calculation and assignments | Step 3.4a |
| 3.4a | Agent | `sprint-planner` | "plan the sprint" / "set up sprint" / "prepare sprint board" | Fully planned Azure sprint with assigned stories | Phase 4 |
| 3.5 | Skill | `azure-task-fetch` | "fetch my tasks" / "what's in the backlog" | Current backlog items with status | — |
| 3.6 | Skill | `azure-task-update` | "update the task" / "mark as done in Azure" | Updated Azure DevOps work item | — |
| 3.7 | Agent | `standup-summarizer` | "standup summary" / "daily standup" / "what got done yesterday" | Standup summary with completed/in-progress/blocked | — |
| 3.8 | Agent | `velocity-tracker` | "track velocity" / "sprint velocity" / "velocity report" | Velocity trend and forecast | Future sprint planning |
| 3.9 | Agent | `bug-triager` | "triage bugs" / "classify new bugs" | Severity/priority classifications, routed to right team | QA phase |

**Chain:**
```
Design artifacts (from Phase 2)
  → user-story-writer (agent)      ← creates stories in Azure DevOps
  → sprint-planner (agent)         ← assigns stories to sprint
  ↓
Phase 4: Implementation
  (developers pull stories from Azure board)
```

---

## Phase 4: Implementation

**Goal:** Build the feature following project conventions — service layer → API route → hooks → component — then guard with auth.

> Always start with `plan-first-instruction` before touching code.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 4.0 | Skill | `plan-first-instruction` | "plan first" / "think before coding" | Structured implementation plan | All of Phase 4 |
| 4.1 | Skill | `db-schema-design` | (if schema not done) "add DB table" | Drizzle schema changes | Step 4.1a |
| 4.1a | Agent | `db-schema-agent` | "design schema" / "add database table" | Drizzle schema file with types, indexes, FK | Step 4.2 |
| 4.2 | Skill | `nextjs-service-layer` | "service layer" / "move DB logic out of routes" | Service module with typed CRUD functions | Step 4.3 |
| 4.2a | Agent | `service-layer-designer` | "create service layer" / "implement service" | Complete service layer module | Step 4.3 |
| 4.3 | Skill | `nextjs-api-route-scaffold` | "create API route" / "new endpoint" / "route.ts" | Full API route with auth, Zod, service call | Step 4.4 |
| 4.3a | Agent | `api-route-builder` | "build API route" / "create endpoint" / "implement REST endpoint" | Complete Next.js API route file | Step 4.4 |
| 4.4 | Agent | `auth-guard` | "add auth check" / "protect this route" / "RBAC for endpoint" | Auth middleware and role assertions on route | Step 4.5 |
| 4.5 | Agent | `error-handler` | "improve error handling" / "standardise errors" | Consistent error responses with logging | Step 4.6 |
| 4.6 | Skill | `shadcn-component-integration` | "shadcn component" / "add UI component" | shadcn/ui component with Tailwind styling | Step 4.7 |
| 4.6a | Agent | `component-scaffolder` | "scaffold component" / "create component" / "build UI component" | Full React component with props, types, barrel export | Step 4.7 |
| 4.7 | Skill | `nextjs-hooks-pattern` | "custom hook" / "data hook" | React hook for data fetching / mutation | Step 4.7a |
| 4.7a | Agent | `api-integrator` | "connect to API" / "fetch data from endpoint" / "wire up API call" | Hook + fetch logic wired to component | Step 4.8 |
| 4.8 | Skill | `nextjs-middleware-scaffold` | "middleware" / "add auth middleware" | Middleware with session/RBAC checks | — |
| 4.9 | Skill | `tailwind-component-scaffold` | "Tailwind component" / "build this UI with Tailwind" | Tailwind-styled component | — |
| 4.10 | Agent | `ui-reviewer` | "review UI" / "check accessibility" / "audit this component" | Accessibility/responsiveness/design review | Phase 5 |
| 4.11 | Agent | `performance-auditor` | "performance audit" / "slow page" / "optimise this component" | Bundle size and render pattern recommendations | Phase 5 |

**Chain:**
```
Sprint stories (from Phase 3)
  → plan-first-instruction (skill)
  → db-schema-agent (agent)        ← Drizzle schema
  → service-layer-designer (agent) ← service module
  → api-route-builder (agent)      ← API route (auth + Zod + service)
  → auth-guard (agent)             ← RBAC protection
  → component-scaffolder (agent)   ← React component
  → api-integrator (agent)         ← hooks wired to component
  ↓
Phase 5: Testing
```

---

## Phase 5: Testing & Quality

**Goal:** Validate correctness at unit, integration, and E2E levels. Catch regressions before PR.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 5.1 | Agent | `test-planner` | "create test plan" / "plan testing for this feature" / "testing strategy" | Test plan: scope, test types, cases, effort | Steps 5.2–5.4 |
| 5.2 | Skill | `unit-test-patterns` | "unit test" / "test this function" | Vitest unit test patterns and mocks | Step 5.2a |
| 5.2a | Agent | `test-writer` | "write tests" / "add unit tests" / "test coverage for this file" | Vitest unit + RTL component tests | Step 5.5 |
| 5.3 | Skill | `integration-test-setup` | "integration test" / "test the service" | Integration test setup with real DB | Step 5.5 |
| 5.4 | Skill | `e2e-testing-setup` | "E2E test" / "Playwright setup" | Playwright config and test scaffold | Step 5.4a |
| 5.4a | Agent | `e2e-test-agent` | "write E2E test" / "Playwright test" / "test user journey" | Full Playwright test for the user flow | Step 5.5 |
| 5.5 | Skill | `build-lint-check` | "run lint" / "build check" / "pre-commit check" | Passing `npm run lint` and `npm run build` | Step 5.6 |
| 5.6 | Skill | `ai-code-review` | "code review" / "review this code" | AI-assisted review report | Step 5.6a |
| 5.6a | Agent | `code-reviewer` | "AI code review" / "review my code" / "second opinion on this code" | Structured code review: correctness, conventions, maintainability | Phase 6 |
| 5.7 | Agent | `coverage-analyzer` | "check test coverage" / "what's untested" / "coverage report" | Prioritised list of missing test coverage | Back to 5.2a |
| 5.8 | Skill | `regression-testing` | "regression test" / "smoke test" | Regression test plan and execution checklist | Phase 6 |
| 5.9 | Skill | `bug-report-template` | "report a bug" / "document this issue" | Structured bug report with repro steps | Azure (Phase 3.9) |
| 5.9a | Agent | `bug-reporter` | "create bug report" / "something is broken" | Full bug report with severity, environment, impact | Azure DevOps |
| 5.10 | Agent | `debug-assistant` | "help me debug" / "what's causing this error" / "diagnose this bug" | Root cause + targeted fix | Back to Phase 4 |

**Chain:**
```
Implemented feature (from Phase 4)
  → test-planner (agent)           ← test plan
  → test-writer (agent)            ← unit + component tests
  → e2e-test-agent (agent)         ← Playwright E2E tests
  → build-lint-check (skill)       ← clean build
  → code-reviewer (agent)          ← structured review
  → coverage-analyzer (agent)      ← coverage gaps
  ↓
Phase 6: Git & PR
```

---

## Phase 6: Git & PR

**Goal:** Commit clean, well-described changes and get them through code review.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 6.1 | Skill | `git-branch-workflow` | "git branch" / "branching strategy" / "create branch" | Branch naming convention and workflow | Step 6.2 |
| 6.2 | Skill | `git-stash-workflow` | "git stash" / "stash my changes" | Stash management steps | Step 6.3 |
| 6.3 | Skill | `git-merge-conflicts` | "merge conflict" / "resolve conflict" | Conflict resolution workflow | Step 6.4 |
| 6.4 | Skill | `feature-commit` | "commit my changes" / "stage and commit" | Staged commit with message | Step 6.5 |
| 6.5 | Skill | `commit-message-formatter` | "format commit message" / "conventional commit" | Conventional-commit formatted message | Step 6.6 |
| 6.6 | Skill | `git-safe-commit` | "safe commit" / "verify before committing" | Pre-commit checks passed, commit created | Step 6.7 |
| 6.7 | Skill | `git-pr-preparation` | "prepare PR" / "ready for PR" / "PR preparation" | Rebased branch, clean history, passing checks | Step 6.8 |
| 6.8 | Skill | `pr-description-generator` | "generate PR description" / "write PR body" | Auto-generated PR description from diff | Step 6.9 |
| 6.9 | Skill | `pr-raise` | "raise a PR" / "create pull request" | PR created on GitHub/Azure with description | Step 6.10 |
| 6.10 | Skill | `code-review-checklist` | "code review checklist" / "what to review" | Reviewer checklist for the PR | Step 6.10a |
| 6.10a | Agent | `pr-reviewer` | "review PR" / "review this pull request" / "check my changes" | Structured PR review: 🔴 must fix / 🟡 should fix / 🟢 suggestions | Phase 7 |

**Chain:**
```
Passing tests (from Phase 5)
  → git-branch-workflow (skill)    ← correct branch name
  → feature-commit (skill)         ← changes staged
  → commit-message-formatter (skill) ← conventional commit
  → git-pr-preparation (skill)     ← rebased, clean history
  → pr-description-generator (skill) ← PR body written
  → pr-raise (skill)               ← PR created
  → pr-reviewer (agent)            ← structured review
  ↓
Phase 7: Deployment
```

---

## Phase 7: Deployment

**Goal:** Ship to production safely with pre-flight security checks, a working CI pipeline, and rollback capability.

| Step | Type | Name | Trigger Phrase | Output | Feeds Into |
|------|------|------|---------------|--------|------------|
| 7.1 | Agent | `security-scanner` | "security scan" / "find vulnerabilities" / "audit dependencies" | Security report: secrets, injection risks, CVEs | Step 7.2 |
| 7.2 | Agent | `pipeline-builder` | "create CI pipeline" / "set up GitHub Actions" / "build pipeline" | GitHub Actions workflow file (lint → test → build → deploy) | Step 7.3 |
| 7.3 | Agent | `deployment-manager` | "deploy to production" / "deployment checklist" / "ship to prod" | Pre-deployment checklist, env audit, deployment command | Step 7.4 |
| 7.4 | Skill | `rollback-helper` | "rollback" / "revert deployment" / "undo deploy" | Rollback steps and verification procedure | — |
| 7.4a | Agent | `rollback-handler` | "rollback deployment" / "revert to previous version" / "production is broken" | Executed rollback to last known good state | — |

**Chain:**
```
Approved PR merged (from Phase 6)
  → security-scanner (agent)       ← no critical vulnerabilities
  → pipeline-builder (agent)       ← CI/CD pipeline configured
  → deployment-manager (agent)     ← deploy to production
  → (if failure) rollback-handler (agent)
  ↓
Done ✓  →  Update app-context skill with "Recent Changes"
```

---

## Cross-Cutting Skills (use at any phase)

These skills are not phase-specific — invoke them whenever relevant.

| Skill / Agent | When to Use | Trigger Phrase |
|---|---|---|
| `app-context` (skill) | Any time you need current project context loaded | Auto-loaded every session |
| `task-clarifier` (skill) | When a task description is ambiguous | "clarify this task" / "what does this mean" |
| `stakeholder-communication` (skill) | Drafting emails, status updates, or meeting summaries | "draft stakeholder update" / "communication template" |
| `tech-stack-selection` (skill) | Evaluating new libraries or approaches | "should we use X or Y" / "technology evaluation" |
| `dependency-audit` (workflow skill) | Checking for vulnerable or outdated packages | "audit dependencies" / "check packages" |
| `branch-strategy-enforcer` (workflow skill) | Enforcing naming conventions | "check branch name" / "enforce branching" |
| `context-manager` (agent) | When context window is getting long | "summarise what we've done" / "prepare handoff" |
| `doc-generator` (agent) | Generating README, JSDoc, or module docs | "write documentation" / "document this module" |
| `prompt-optimizer` (agent) | Improving a Claude prompt | "improve this prompt" / "optimise prompt" |

---

## Quick Reference: Skill → Agent Mapping

| Area | Use this Skill first | Then escalate to Agent |
|---|---|---|
| Requirements | `requirements-gathering` | `requirements-analyst` |
| BRD | `brd-template` | `brd-generator` |
| HLD | `hld-template` | `hld-architect` |
| API Design | `api-design-patterns` | `api-contract-designer` |
| DB Schema | `db-schema-design` | `db-schema-agent` / `db-schema-designer` |
| ADR | `architecture-decision-record` | `adr-writer` |
| User Stories | `azure-user-story-creation` | `user-story-writer` |
| Sprint Planning | `azure-sprint-planning` | `sprint-planner` |
| API Route | `nextjs-api-route-scaffold` | `api-route-builder` |
| Service Layer | `nextjs-service-layer` | `service-layer-designer` |
| Component | `shadcn-component-integration` | `component-scaffolder` |
| Hooks / API wiring | `nextjs-hooks-pattern` | `api-integrator` |
| Auth / RBAC | `nextjs-middleware-scaffold` | `auth-guard` |
| Unit Tests | `unit-test-patterns` | `test-writer` |
| E2E Tests | `e2e-testing-setup` | `e2e-test-agent` |
| Code Review | `ai-code-review` | `code-reviewer` |
| PR | `git-pr-preparation` + `pr-description-generator` | `pr-reviewer` |
| Deploy | — | `deployment-manager` |
| Bug | `bug-report-template` | `bug-reporter` / `debug-assistant` |
