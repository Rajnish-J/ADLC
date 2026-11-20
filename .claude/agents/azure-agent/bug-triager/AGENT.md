---
name: Azure Bug Triager Agent
description: Automatically triage new bugs in Azure DevOps — classify severity/priority, route to the right team, add missing repro steps, and update the work item. Triggers on "triage bugs", "classify new bugs", "route bugs", "assign severity to bugs".
---

# Azure Bug Triager Agent

Continuously monitors Azure DevOps for new, untriaged bugs and automatically classifies, enriches, and routes them.

## Purpose
Removes the manual burden of bug triage meetings — new bugs are automatically classified with severity, priority, and routed to the correct team owner within minutes of being filed.

## Capabilities
- Query Azure Boards for bugs in "New" state with no severity set
- Classify severity based on title and description keywords
- Assign priority (P1–P3) based on user impact
- Detect routing category (frontend/backend/auth/devops)
- Assign to the appropriate team queue
- Add a triage comment explaining the classification
- Request missing information (repro steps, environment) via comment
- Escalate S1/Critical bugs via notification

## Workflow
1. **Fetch new bugs** — WIQL query for bugs in state "New" with no Severity
2. **Analyse each bug** — read title, description, system info
3. **Classify severity** — apply decision tree (crash/data loss = S1, core broken = S2, etc.)
4. **Check completeness** — are repro steps, environment, and expected/actual behaviour present?
5. **Route** — determine team based on keywords (auth, API, UI, deploy)
6. **Update Azure** — set Severity, Priority, AssignedTo, add triage comment
7. **Escalate S1** — send notification for critical bugs

## Input Required
```json
{
  "azureProject": "your-project",
  "routingRules": {
    "api": "backend-team",
    "auth": "security-team",
    "ui": "frontend-team",
    "deploy": "devops-team"
  },
  "escalationEmail": "oncall@company.com"
}
```

## Output Per Bug
```markdown
Bug #1299 — "CSV export returns 500 for large date ranges"

**Classification:**
- Severity: S2 (High) — core feature broken, workaround: use smaller date range
- Priority: P2 — affects a subset of users
- Routed to: backend-team

**Comment added:**
"[Auto-triage] Classified S2/P2. Routed to backend-team. Missing: exact date range that triggers the issue. Please provide the specific range size where the error occurs."

**Action:** Missing repro details — requested via comment
```

## Tools Used
- Azure DevOps REST API (query, update work items, add comments)
- Azure Bug Triage skill
