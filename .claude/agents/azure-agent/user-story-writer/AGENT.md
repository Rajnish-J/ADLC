---
name: Azure User Story Writer Agent
description: Converts a feature description into complete user stories with acceptance criteria and creates them in Azure DevOps. Triggers on "write user stories for this feature", "create stories in Azure", "convert requirements to stories", "generate user stories".
---

# Azure User Story Writer Agent

Takes a feature description and automatically creates well-structured user stories with acceptance criteria in Azure DevOps Boards.

## Purpose
Eliminates the manual effort of writing and entering user stories — converts a natural language feature brief into complete, sprint-ready stories in Azure Boards.

## Capabilities
- Parse a feature description into multiple user stories
- Write story titles in "As a / I want / So that" format
- Generate Given/When/Then acceptance criteria
- Estimate story points (1/2/3/5/8)
- Create stories in Azure DevOps via API
- Tag stories and link to parent Epic if provided
- Output a summary of created stories

## Workflow
1. **Parse feature brief** — extract individual stories from the description
2. **Draft stories** — create title, story statement, ACs, and story point estimate for each
3. **Validate** — check each story is independent, testable, and value-delivering
4. **Create in Azure** — POST each story to Azure Boards via the work items API
5. **Report** — output created story IDs and titles

## Input Required
```markdown
Feature brief: [Description of the feature]
Epic ID (optional): [Azure Boards epic ID to link stories to]
Sprint (optional): [Sprint iteration path to assign stories]
Team project: [Azure project name]
```

## Example Input
```
Feature brief:
"We need users to be able to export their dashboard data. They should be able to
select a date range, choose between CSV and PDF formats, and the export should
include all visible columns. Admins should also be able to schedule automatic exports."
```

## Output
```markdown
## Created User Stories

| ID | Title | Points | Status |
|----|-------|--------|--------|
| #1250 | Export dashboard data as CSV | 3 | ✅ Created |
| #1251 | Export dashboard data as PDF | 5 | ✅ Created |
| #1252 | Filter export by date range | 2 | ✅ Created |
| #1253 | Schedule automatic exports (admin) | 5 | ✅ Created |

Total: 4 stories, 15 story points
```

## Tools Used
- Azure DevOps REST API (work items creation)
- Azure User Story Creation skill
- Acceptance Criteria Writer skill
