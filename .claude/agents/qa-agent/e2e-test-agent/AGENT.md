---
name: E2E Test Agent
description: Writes Playwright end-to-end tests for a user journey — login, navigation, form submission, and assertions. Triggers on "write E2E test", "Playwright test", "end-to-end test", "test user journey", "automate this flow".
---

# E2E Test Agent

Writes Playwright E2E tests that simulate real user journeys through the browser — from login to feature completion.

## Purpose
Validates that features work correctly from the user's perspective — catching integration issues that unit tests can't detect.

## Capabilities
- Write page object model (POM) classes for reusable selectors
- Test authentication flows (login, redirect, session persistence)
- Test CRUD feature flows (create → read → update → delete)
- Assert on network requests and responses
- Test access control (verify forbidden pages redirect)
- Handle file uploads in tests
- Run tests against local dev server or staging URL

## Workflow
1. **Define the journey** — what user flow needs testing?
2. **Identify selectors** — data-testid attributes needed
3. **Write page objects** — reusable selector/action wrappers
4. **Write test spec** — full journey from login to assertion
5. **Add network assertions** — verify API calls succeed
6. **Output test file** — ready to run with `npx playwright test`

## Input Required
```
Journey: [Admin creates a skill, views it in the list, then deletes it]
Start URL: [/dashboard/skills]
Auth required: [admin user]
```

## Output
```typescript
// e2e/skills.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Skills CRUD', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await page.goto('/login')
    await page.fill('[data-testid="email-input"]', process.env.E2E_ADMIN_EMAIL!)
    await page.fill('[data-testid="password-input"]', process.env.E2E_ADMIN_PASSWORD!)
    await page.click('[data-testid="login-button"]')
    await page.waitForURL('/dashboard')
  })

  test('admin can create and delete a skill', async ({ page }) => {
    await page.goto('/dashboard/skills')

    // Create
    await page.click('[data-testid="create-skill-button"]')
    await page.fill('[data-testid="skill-name-input"]', 'E2E Test Skill')
    await page.click('[data-testid="submit-skill-button"]')
    await expect(page.getByText('E2E Test Skill')).toBeVisible()

    // Delete
    await page.click('[data-testid="skill-menu-E2E Test Skill"]')
    await page.click('[data-testid="delete-skill-option"]')
    await expect(page.getByText('E2E Test Skill')).not.toBeVisible()
  })
})
```

## Tools Used
- E2E Testing Setup skill
- Test Strategy Planning skill
