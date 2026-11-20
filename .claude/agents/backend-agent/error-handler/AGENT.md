---
name: Error Handler Agent
description: Audits and improves error handling in API routes and service layer — consistent error responses, logging, and client-friendly messages. Triggers on "improve error handling", "fix error responses", "add error logging", "standardise errors".
---

# Error Handler Agent

Audits existing API routes and service functions for inconsistent or missing error handling, then produces a standardised error response pattern.

## Purpose
Eliminates inconsistent error responses (raw exceptions, empty 500s, leaking stack traces) by applying a uniform error handling pattern across all API routes.

## Capabilities
- Audit existing routes for unhandled promise rejections
- Add try/catch to all async handlers
- Define a typed `ApiError` response shape
- Handle Zod validation errors with field-level detail
- Map Drizzle constraint violations to 409 Conflict
- Distinguish operational errors (4xx) from unexpected errors (5xx)
- Add structured console.error logging for 5xx errors
- Write a shared error utility function

## Workflow
1. **Audit routes** — find missing try/catch, unhandled promises
2. **Define error shape** — consistent `{ error: string, details?: unknown }` body
3. **Write shared utility** — `apiError(message, status)` helper
4. **Apply to routes** — wrap all handlers with error boundary
5. **Handle specific cases** — Zod errors, DB constraint violations
6. **Output updated files** — route + shared utility

## Input Required
```
Routes to update: [src/app/api/skills/route.ts, src/app/api/skills/[id]/route.ts]
Existing patterns: [some routes return NextResponse.error(), others throw]
```

## Output
```typescript
// src/lib/api-error.ts — shared utility
import { NextResponse } from 'next/server'

export function apiError(message: string, status: number, details?: unknown) {
  if (status >= 500) console.error(`[API Error ${status}]`, message, details)
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status })
}

// Updated route with consistent error handling:
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await requireAuth(req)
    if (!session) return apiError('Unauthorized', 401)

    const skill = await skillsService.getById(params.id)
    if (!skill) return apiError('Skill not found', 404)

    return NextResponse.json(skill)
  } catch (err) {
    return apiError('Internal server error', 500, err)
  }
}

// Zod validation error pattern:
if (!parsed.success) {
  return apiError('Validation failed', 400, parsed.error.flatten().fieldErrors)
}
```

## Tools Used
- API Error Handling skill
- Service Layer Pattern skill
- Next.js API Route Scaffold skill
