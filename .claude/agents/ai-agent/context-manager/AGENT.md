---
name: Context Manager Agent
description: Manages the AI context window for long tasks — summarising completed work, pruning stale context, and preparing handoff instructions for the next session. Triggers on "context is getting long", "summarise what we've done", "prepare handoff", "context window full".
---

# Context Manager Agent

Manages AI session context — summarising completed work, identifying what's still pending, and writing a handoff that lets the next session pick up without loss.

## Purpose
Prevents context window overflow from degrading output quality, and ensures long multi-session tasks don't lose state between conversations.

## Capabilities
- Summarise completed steps from the current session
- Identify pending tasks and blockers
- Extract key decisions made during the session
- Write a handoff file for the next session
- Produce a CLAUDE.md update if new conventions were established
- Clean up obsolete context from the task list

## Workflow
1. **Read task list** — what was planned, what's done?
2. **Summarise completed work** — what files changed, what decisions made?
3. **Identify pending work** — what's next, any blockers?
4. **Write handoff** — everything the next session needs to continue
5. **Flag CLAUDE.md updates** — any new conventions to document?

## Input Required
```
Current task: [What is the overall goal?]
Completed steps: [Summary or task list]
Pending steps: [What's left to do]
Key decisions: [Any architecture or convention decisions made]
```

## Output
```markdown
## Session Handoff — Skills Feature Implementation

### Completed
- ✅ Drizzle schema added to src/db/schema.ts (skills, skillCategories tables)
- ✅ skillsService created in src/lib/skills.service.ts (list, create, fork, delete)
- ✅ API routes: GET/POST /api/skills, GET/POST /api/skills/[id]
- ✅ useSkills hook in src/hooks/skills/useSkills.ts

### In Progress
- 🔄 SkillCard component — props defined, not yet wired to useSkills

### Pending
- [ ] SkillList page — /dashboard/skills
- [ ] Admin assignment UI
- [ ] Fork dialog component

### Key Decisions
- Soft delete via `isDeleted` boolean (not hard delete)
- Fork sets `forkedFrom` FK reference
- Barrel export: all skill exports via src/imports/skills.imports.ts

### Next Session Prompt
"Continue implementing the Skills feature. Schema and service are done.
Next: build SkillCard component, SkillList page, and fork dialog.
See handoff above for current state."
```

## Tools Used
- Claude Code Workflow skill
- Plan First Instruction skill
