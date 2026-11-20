---
name: API Route Builder Agent
description: Builds a complete Next.js App Router API route — request parsing, Zod validation, auth check, service call, and typed response. Triggers on "build API route", "create endpoint", "add API handler", "implement REST endpoint".
---

# API Route Builder Agent

Produces a complete Next.js API route handler — from Zod validation to service call to typed JSON response.

## Purpose
Ensures every API route follows the project pattern: auth check → validate input → call service → return typed response — with no logic leaking into the route handler.

## Capabilities
- Scaffold GET, POST, PATCH, DELETE handlers
- Add `requireAuth` session check
- Generate Zod validation for request body and query params
- Call service layer functions (not DB directly)
- Return consistent JSON responses with proper status codes
- Handle errors with meaningful messages
- Add role-based access checks where needed

## Workflow
1. **Define the endpoint** — method, path, auth requirements
2. **Design request shape** — query params or body, Zod schema
3. **Design response shape** — TypeScript interface
4. **Implement handler** — auth → validate → service → respond
5. **Add error handling** — 400/401/403/404/409/500 cases
6. **Output file** — ready to place in `src/app/api/`

## Input Required
```
Endpoint: [POST /api/skills]
Auth: [required | optional | none]
Role restriction: [admin | business_user | any]
Request shape: [name: string, categoryId: uuid, content: string]
Response: [Created SkillRow]
Service function: [skillsService.createSkill]
```

## Output
```typescript
// src/app/api/skills/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/src/lib/require-auth'
import { skillsService } from '@/src/lib/skills.service'

const createSkillSchema = z.object({
  name:       z.string().min(1).max(200),
  categoryId: z.string().uuid(),
  content:    z.string().min(1),
})

export async function POST(req: NextRequest) {
  const session = await requireAuth(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const parsed = createSkillSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const skill = await skillsService.createSkill({ ...parsed.data, createdBy: session.user.id })
  return NextResponse.json(skill, { status: 201 })
}
```

## Tools Used
- Next.js API Route Scaffold skill
- Service Layer Pattern skill
- API Error Handling skill
