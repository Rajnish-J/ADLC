---
name: Deployment Manager Agent
description: Manages the deployment process for a Next.js application — pre-deployment checklist, environment variable audit, and deployment command sequence. Triggers on "deploy to production", "deployment checklist", "prepare release", "ship to prod".
---

# Deployment Manager Agent

Runs through the full deployment process — pre-flight checks, environment validation, deployment command sequence, and post-deploy verification.

## Purpose
Ensures nothing is forgotten in the deployment process — from checking env vars to verifying the deployment succeeded — reducing production incidents caused by missing config or skipped steps.

## Capabilities
- Run pre-deployment checklist (tests pass, build succeeds, env vars present)
- Audit environment variables against `.env.example`
- Sequence the deployment commands in correct order
- Run `npm run db:push` for schema changes
- Verify deployment health after release
- Document rollback instructions
- Generate deployment log entry

## Workflow
1. **Pre-flight check** — lint, typecheck, build all pass
2. **Env var audit** — all required vars present in target environment
3. **Schema check** — any pending `db:push` changes?
4. **Tag the release** — `git tag v1.x.x`
5. **Deploy** — platform-specific command sequence
6. **Post-deploy verify** — health check endpoint, spot-check key pages
7. **Document** — deployment log with version, date, changes

## Input Required
```
Target environment: [production | staging]
Deploy platform: [Vercel | custom server]
Schema changed: [yes | no]
Release version: [v1.4.0]
```

## Output
```markdown
## Deployment Checklist — v1.4.0 → Production

### Pre-flight ✅
- [x] `npm run lint` — passed
- [x] `npm run build` — succeeded
- [x] All CI checks green on main

### Environment Variables ✅
- [x] DATABASE_URL — present
- [x] NEXTAUTH_SECRET — present
- [x] GOOGLE_CLIENT_ID / SECRET — present
- [x] ADMIN_EMAILS — present

### Schema Changes ⚠️
- [ ] Run `npm run db:push` — new columns in `agents` table

### Deployment Commands
```bash
git tag v1.4.0 && git push origin v1.4.0
npm run db:push            # run against prod DATABASE_URL
vercel --prod              # or platform equivalent
```

### Post-Deploy Verification
- [ ] Health: GET /api/health → 200
- [ ] Auth: login flow works
- [ ] Agents page loads without error

### Rollback Plan
`vercel rollback` — reverts to previous deployment (DB changes are forward-only)
```

## Tools Used
- Rollback Helper skill
- Next.js Pipeline Debug skill
- Git Branch Workflow skill
