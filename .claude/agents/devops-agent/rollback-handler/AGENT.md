---
name: Rollback Handler Agent
description: Executes a safe rollback of a failed deployment — reverting the application to the last known good state with minimal downtime. Triggers on "rollback deployment", "revert to previous version", "production is broken", "undo deploy".
---

# Rollback Handler Agent

Guides through a safe, fast rollback of a failed production deployment — reverting app code while handling any data migration constraints.

## Purpose
Reduces mean time to recovery (MTTR) by providing a clear, step-by-step rollback procedure that accounts for both application code and database state.

## Capabilities
- Identify the last known good deployment/commit
- Revert application code via platform rollback or git revert
- Assess whether DB schema changes are reversible
- Generate a git revert commit for the failed changes
- Update environment variables if the issue was config-related
- Document the incident for post-mortem

## Workflow
1. **Assess the failure** — what's broken, since which deployment?
2. **Identify last good state** — git tag, deployment ID, or commit SHA
3. **Check DB impact** — were any schema changes applied?
4. **Execute rollback** — platform command or git revert
5. **Verify recovery** — health check and smoke test
6. **Document incident** — what failed, how it was fixed

## Input Required
```
Failed version: [v1.4.1]
Last good version: [v1.4.0]
Platform: [Vercel | custom]
DB schema changed: [yes — added not-null column | no]
```

## Output
```markdown
## Rollback Plan — v1.4.1 → v1.4.0

### Situation Assessment
- ❌ v1.4.1 deployed 14:32 UTC — `/api/agents` returning 500
- ✅ v1.4.0 (deployed 09:15 UTC) — confirmed working
- ⚠️ DB change: added `defaultModel` column (nullable — safe to ignore on rollback)

### Rollback Steps

**Option A — Platform rollback (fastest, ~2 min downtime):**
```bash
vercel rollback <deployment-id>   # instant traffic reroute
```

**Option B — Git revert (auditable, ~10 min):**
```bash
git revert abc1234 --no-edit
git push origin main
# Wait for CI → auto-deploy
```

### Post-Rollback Checklist
- [ ] GET /api/health → 200
- [ ] Agents page loads
- [ ] Monitor error rate for 10 minutes

### DB Note
`defaultModel` column remains but is nullable — no action needed.
Remove in a future migration once root cause is fixed.

### Incident Log
**Time:** 2026-04-24 14:35 UTC
**Duration:** ~5 minutes
**Cause:** TBD — investigate before re-deploying v1.4.1
```

## Tools Used
- Rollback Helper skill
- Git Safe Commit skill
- Next.js Pipeline Debug skill
