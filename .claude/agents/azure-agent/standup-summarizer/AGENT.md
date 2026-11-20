---
name: Azure Standup Summarizer Agent
description: Generates a daily standup summary from Azure DevOps work item activity — what was completed yesterday, what's in progress today, and what's blocked. Triggers on "standup summary", "daily standup", "what got done yesterday", "generate standup", "morning update".
---

# Azure Standup Summarizer Agent

Automatically generates the team's daily standup summary from Azure DevOps activity — no manual status updates needed.

## Purpose
Replaces the "what did you do yesterday?" part of standups with an auto-generated summary from actual Azure Boards activity, freeing the meeting for blockers and decisions.

## Capabilities
- Fetch all work items updated in the last 24 hours per team member
- Categorise activity: completed, in progress, moved, commented
- Detect blocked items (tag-based or state-based)
- Format output as a standup-ready report
- Post report as a comment on the sprint work item or Teams/Slack message

## Workflow
1. **Fetch yesterday's activity** — WIQL query for items changed in last 24 hours
2. **Group by assignee** — organise changes per team member
3. **Categorise changes** — state transitions, comments added, work logged
4. **Identify blockers** — items tagged "blocked" or with "blocked" in comments
5. **Format report** — produce per-member standup summary
6. **Post/share** — output to terminal, file, or post to Teams webhook

## Input Required
```json
{
  "sprintName": "Sprint 43",
  "teamMembers": ["Rajnish J", "Priya S", "Dev C"],
  "timezone": "Asia/Kolkata"
}
```

## Output
```markdown
## Daily Standup — 24 April 2026

### Rajnish J
**Yesterday:**
- ✅ Completed: #1234 Add Google OAuth login
- 🔄 Updated: #1240 User profile page (moved to In Progress)

**Today:**
- 🎯 #1240 User profile page
- 🎯 #1241 Email notifications (starting today)

**Blockers:** None

---

### Priya S
**Yesterday:**
- 🔄 #1235 Fix CSV export (added comment with investigation notes)
- 🔄 #1241 Email notifications (In Progress)

**Today:**
- 🎯 #1235 CSV export fix
- 🎯 #1241 Email notifications

**Blockers:** ⚠️ #1235 — waiting for Sentry access to view production logs

---

### Summary
- 1 story completed yesterday
- 3 stories in flight
- 1 blocker needs attention
```

## Tools Used
- Azure DevOps REST API (WIQL, work item history)
- User Story Report Generator skill
