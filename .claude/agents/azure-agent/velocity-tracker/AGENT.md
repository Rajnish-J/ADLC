---
name: Azure Velocity Tracker Agent
description: Tracks team velocity across sprints — completed story points, trend analysis, and forecast for future sprints. Triggers on "track velocity", "sprint velocity", "how fast is the team", "velocity report", "forecast next sprint".
---

# Azure Velocity Tracker Agent

Analyses sprint history to calculate team velocity, identify trends, and forecast future sprint capacity.

## Purpose
Provides data-driven sprint planning by tracking actual velocity over time — removes guesswork from capacity planning.

## Capabilities
- Fetch completed sprints and their closed story points from Azure
- Calculate average, median, and rolling velocity
- Identify velocity trends (improving/declining)
- Flag sprint anomalies (holidays, incidents, team changes)
- Generate velocity chart data
- Forecast next sprint capacity with confidence range

## Workflow
1. **Fetch sprint history** — get all completed sprints for the last 3 months
2. **Count completed points** — sum story points for "Done/Closed" stories per sprint
3. **Calculate metrics** — average, median, rolling 3-sprint average
4. **Identify trends** — compare last sprint to rolling average
5. **Generate forecast** — recommend capacity for next sprint
6. **Output report** — velocity table, trend indicator, recommendation

## Input Required
```json
{
  "azureProject": "your-project",
  "teamName": "core-team",
  "sprintsToAnalyse": 6
}
```

## Output
```markdown
## Velocity Report — Core Team

| Sprint | Completed Points | Status |
|--------|----------------|--------|
| Sprint 37 | 14 | ✅ |
| Sprint 38 | 12 | ✅ |
| Sprint 39 | 16 | ✅ |
| Sprint 40 | 11 | ⚠️ (holiday week) |
| Sprint 41 | 15 | ✅ |
| Sprint 42 | 14 | ✅ |

**Average velocity:** 13.7 points
**Rolling 3-sprint average:** 14.3 points
**Trend:** Stable ↔

**Recommendation for Sprint 43:**
- Target: 14 points (80% of 18-point capacity)
- Confidence: High (low variance over last 3 sprints)
- Note: Sprint 40 anomaly (holiday) excluded from average
```

## Tools Used
- Azure DevOps REST API (iterations, work items)
- Azure Sprint Planning skill
