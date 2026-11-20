---
name: Azure Sprint Planner Agent
description: Autonomously plan a sprint in Azure DevOps — fetch backlog, calculate team capacity, suggest story selection, create the sprint, and assign stories. Triggers on "plan the sprint", "set up sprint", "sprint planning agent", "prepare sprint board".
---

# Azure Sprint Planner Agent

Automates the sprint planning ceremony — fetches the backlog, calculates capacity, selects stories, creates the sprint in Azure Boards, and assigns stories.

## Purpose
Takes a team capacity input and sprint dates, then fully plans the sprint in Azure DevOps without manual board manipulation.

## Capabilities
- Fetch and prioritise the backlog from Azure DevOps
- Calculate sprint capacity from team member availability
- Select stories that fit within capacity (80% buffer)
- Create the sprint iteration in Azure Boards
- Move selected stories to the sprint
- Generate a sprint planning summary report

## Workflow
1. **Input gathering** — collect sprint name, dates, team member availability
2. **Backlog fetch** — WIQL query for all unassigned backlog stories sorted by priority
3. **Capacity calculation** — sum team hours, convert to story points (÷5 hours/point)
4. **Story selection** — select top-priority stories until 80% of capacity is reached
5. **Sprint creation** — POST to Azure iterations API to create the sprint
6. **Story assignment** — PATCH each selected story's IterationPath
7. **Summary generation** — produce a sprint plan document

## Input Required
```json
{
  "sprintName": "Sprint 43",
  "startDate": "2026-05-05",
  "endDate": "2026-05-16",
  "teamMembers": [
    { "name": "Rajnish J", "daysAvailable": 9, "hoursPerDay": 6 },
    { "name": "Priya S", "daysAvailable": 10, "hoursPerDay": 6 }
  ]
}
```

## Output
```markdown
## Sprint 43 Plan

**Capacity:** 90 hours = 18 story points (80% buffer = 14 points)
**Selected:** 14 points across 5 stories

| Story | Title | Points | Assignee |
|-------|-------|--------|----------|
| #1234 | Add Google OAuth | 3 | Rajnish J |
| #1235 | Fix CSV export timeout | 2 | Priya S |
| #1240 | User profile page | 5 | Rajnish J |
| #1241 | Email notifications | 3 | Priya S |
| #1242 | Audit log | 2 | Rajnish J |

Sprint created: ✅
Stories assigned: ✅
```

## Tools Used
- Azure DevOps REST API (WIQL queries, iterations, work items)
- Azure Task Fetch skill
- Azure Sprint Planning skill
