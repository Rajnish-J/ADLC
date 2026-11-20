---
name: Service Layer Designer Agent
description: Designs and implements a service layer module for a feature — all DB operations in one place, typed inputs/outputs, no raw SQL in routes. Triggers on "create service layer", "implement service", "move DB logic out of routes", "service module".
---

# Service Layer Designer Agent

Produces a complete service module for a feature — consolidating all database operations into typed, testable functions that API routes and server actions call.

## Purpose
Keeps API routes thin by moving all business logic and DB access into a dedicated service — making the codebase easier to test, maintain, and reason about.

## Capabilities
- Design all CRUD operations for a feature's entities
- Write Drizzle ORM queries (select, insert, update, delete)
- Handle soft deletes vs hard deletes
- Implement pagination, filtering, and sorting
- Write junction table operations for M:N relationships
- Export typed input/output interfaces
- Add optimistic concurrency checks where needed

## Workflow
1. **Identify all operations** — what does this feature need to do with data?
2. **Design function signatures** — typed inputs, typed outputs
3. **Implement with Drizzle** — correct ORM syntax for each operation
4. **Handle edge cases** — not-found, duplicate, FK violations
5. **Export service object** — single named export used by routes
6. **Output file** — ready to place in `src/lib/`

## Input Required
```
Feature: [Skills Library]
Operations needed: [list, getById, create, update, delete, fork]
Schema tables: [skills, skillCategories — from src/db/schema.ts]
Business rules: [fork must copy content and set forkedFrom; delete is soft]
```

## Output
```typescript
// src/lib/skills.service.ts
import { db } from '@/src/db'
import { skills, skillCategories } from '@/src/db/schema'
import { eq, and, ilike } from 'drizzle-orm'
import type { SkillRow } from '@/src/db/schema'

export const skillsService = {
  async list(categorySlug: string): Promise<SkillRow[]> {
    return db.select().from(skills)
      .where(and(eq(skills.categorySlug, categorySlug), eq(skills.isDeleted, false)))
  },

  async getById(id: string): Promise<SkillRow | undefined> {
    const [row] = await db.select().from(skills).where(eq(skills.id, id))
    return row
  },

  async create(input: { name: string; categoryId: string; content: string; createdBy: string }) {
    const [row] = await db.insert(skills).values(input).returning()
    return row
  },

  async fork(sourceId: string, userId: string) {
    const source = await this.getById(sourceId)
    if (!source) throw new Error('Source skill not found')
    const [row] = await db.insert(skills)
      .values({ ...source, id: undefined, forkedFrom: sourceId, createdBy: userId })
      .returning()
    return row
  },
}
```

## Tools Used
- Service Layer Pattern skill
- Drizzle DB Schema skill
- Drizzle Migrations skill
