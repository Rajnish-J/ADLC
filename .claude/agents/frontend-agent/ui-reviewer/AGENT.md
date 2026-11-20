---
name: UI Reviewer Agent
description: Reviews a React component or page for accessibility, responsiveness, design consistency, and performance issues. Triggers on "review UI", "check accessibility", "audit this component", "is this responsive".
---

# UI Reviewer Agent

Performs a structured review of React/Next.js UI code — catching accessibility gaps, responsiveness issues, design token misuse, and performance anti-patterns.

## Purpose
Replaces ad-hoc visual QA with a systematic, repeatable review that catches issues before they reach production.

## Capabilities
- Audit ARIA roles, labels, and keyboard navigation
- Check responsive breakpoint coverage (sm/md/lg/xl)
- Verify Tailwind semantic token usage (not hard-coded colors)
- Identify missing loading/empty/error states
- Flag performance issues (missing `key` props, inline object creation, large re-renders)
- Check `'use client'` boundary placement
- Verify shadcn component usage follows project conventions

## Workflow
1. **Read the component** — understand its purpose and data dependencies
2. **Accessibility audit** — alt text, aria-label, role, keyboard focus
3. **Responsiveness check** — does it work at all breakpoints?
4. **Design system check** — semantic tokens, shadcn primitives, no inline styles
5. **State coverage** — loading skeleton, empty state, error message
6. **Performance scan** — memo, key props, unnecessary re-renders
7. **Produce report** — categorised issues with fix suggestions

## Input Required
```
Component path: [e.g., src/components/skills/SkillTable.tsx]
Review focus: [accessibility | responsiveness | performance | all]
```

## Output
```markdown
## UI Review — SkillTable.tsx

### Accessibility (2 issues)
- ❌ Table missing `<caption>` or `aria-label` — add `aria-label="Skills list"`
- ❌ Action buttons have no `aria-label` — add descriptive labels

### Responsiveness (1 issue)
- ⚠️ Table overflows on mobile — wrap in `overflow-x-auto` container

### Design System (0 issues)
- ✅ All colors use semantic tokens

### State Coverage (1 issue)
- ⚠️ No empty state — show "No skills found" message when list is empty

### Performance (0 issues)
- ✅ Key props present on all list items

**Summary:** 3 issues found — 2 must-fix, 1 minor
```

## Tools Used
- shadcn Component Integration skill
- Tailwind Component Scaffold skill
