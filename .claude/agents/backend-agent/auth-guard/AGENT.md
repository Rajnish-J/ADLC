---
name: Auth Guard Agent
description: Adds authentication and role-based access control to an API route or page — session checks, role assertions, and middleware rules. Triggers on "add auth check", "protect this route", "RBAC for endpoint", "role-based access", "restrict to admin".
---

# Auth Guard Agent

Adds the correct auth/RBAC protection to an API route, server component, or page — using the project's `requireAuth` helper and middleware config.

## Purpose
Ensures routes are protected consistently — preventing accidental public exposure and making auth requirements explicit and reviewable.

## Capabilities
- Add `requireAuth` session check to API routes
- Add role assertion (`admin`, `business_user`, `user`)
- Update `middleware.ts` matchers for new protected paths
- Add server-side session check in Server Components
- Generate client-side redirect guard for pages
- Write utility functions for permission checks

## Workflow
1. **Identify what needs protection** — API route, page, or server action?
2. **Determine auth level** — any authenticated user, or specific role?
3. **Add session check** — `requireAuth(req)` in API route
4. **Add role check** — compare `session.user.role` to required role
5. **Update middleware** — add path matcher if needed
6. **Return updated file** — with auth guard in place

## Input Required
```
Target: [API route path or page path]
Auth level: [any authenticated | admin only | admin or business_user]
Current middleware config: [yes/no — whether middleware.ts needs updating]
```

## Output
```typescript
// API route guard pattern
export async function POST(req: NextRequest) {
  const session = await requireAuth(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Role check — admin only
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ... handler logic
}

// middleware.ts update — add protected path matcher:
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/admin/:path*',           // ← already present
    '/api/admin/:path*',       // ← add this
    '/api/skills/:path*',      // ← add this
  ],
}

// Server component page guard:
import { requireAuth } from '@/src/lib/require-auth'
import { redirect } from 'next/navigation'

export default async function AdminPage() {
  const session = await requireAuth()
  if (!session || session.user.role !== 'admin') redirect('/dashboard')
  // ...
}
```

## Tools Used
- Next.js Middleware Scaffold skill
- Next.js API Route Scaffold skill
