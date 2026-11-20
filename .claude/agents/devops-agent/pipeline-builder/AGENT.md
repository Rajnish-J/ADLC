---
name: Pipeline Builder Agent
description: Creates or updates a GitHub Actions CI/CD pipeline for a Next.js project — lint, typecheck, test, build, and deploy stages. Triggers on "create CI pipeline", "set up GitHub Actions", "add CI/CD", "build pipeline", "automate deployment".
---

# Pipeline Builder Agent

Builds a complete GitHub Actions workflow for a Next.js project — covering lint, type checking, tests, build validation, and deployment.

## Purpose
Gets CI/CD running from scratch or updates an existing pipeline to cover new requirements — ensuring every PR is validated before merge.

## Capabilities
- Create multi-job GitHub Actions workflow
- Configure caching for `node_modules` and Next.js build cache
- Run ESLint, TypeScript type check, Vitest unit tests
- Run Playwright E2E tests with browser installation
- Build the Next.js app to validate production output
- Deploy to Vercel or custom server on merge to main
- Set up environment variable secrets
- Add branch protection rules documentation

## Workflow
1. **Assess current state** — does a workflow exist? What's missing?
2. **Design pipeline stages** — which jobs run in parallel vs sequence
3. **Write workflow file** — `.github/workflows/ci.yml`
4. **Configure caching** — npm and Next.js cache for fast runs
5. **Add test stage** — unit + E2E if Playwright is configured
6. **Add deploy stage** — conditional on branch and job success
7. **Document secrets** — what env vars need to be added to GitHub

## Input Required
```
Project type: [Next.js 16 App Router]
Tests: [Vitest unit tests | Playwright E2E | both | none]
Deploy target: [Vercel | none]
Branch strategy: [PR → main | develop → staging → main]
```

## Output
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  lint-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint
      - run: npx tsc --noEmit

  test:
    runs-on: ubuntu-latest
    needs: lint-typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm test
    env:
      DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run build

# Required GitHub secrets: TEST_DATABASE_URL, NEXTAUTH_SECRET
```

## Tools Used
- Next.js Pipeline Debug skill
- Git Branch Workflow skill
- Rollback Helper skill
