'use client'

// login-03's card, for the local-development sign-in: pick one of the seeded users (one per role). Microsoft
// Entra ID sign-in replaces this list once the sdlc-api app registration exists.

import { ChevronRight } from 'lucide-react'
import type { User } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldDescription } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/common/user-avatar'
import { cn } from '@/lib/utils'

const ROLE_HINT: Record<string, string> = {
  'admin@sdlc.local': 'Org admin — every project, creates projects',
  'owner@sdlc.local': 'Owner of Payments Portal',
  'lead@sdlc.local': 'Lead on Payments, owner of Onboarding',
  'dev1@sdlc.local': 'Developer on Payments',
  'dev2@sdlc.local': 'Developer on Payments and Onboarding',
  'viewer@sdlc.local': 'Viewer on Payments (read-only)',
}

interface LoginFormProps {
  users: User[] | null
  busyEmail: string | null
  onChoose: (email: string) => void
  className?: string
}

export function LoginForm({ users, busyEmail, onChoose, className }: LoginFormProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Local development — choose who to sign in as. Each user has a different role.</CardDescription>
        </CardHeader>
        <CardContent>
          {users ? (
            <ItemGroup className="gap-2">
              {users.map((u) => (
                <Item key={u.id} variant="outline" size="sm" asChild>
                  <button
                    type="button"
                    disabled={busyEmail !== null}
                    onClick={() => onChoose(u.email)}
                    className="w-full text-left hover:bg-muted disabled:opacity-60"
                  >
                    <ItemMedia>
                      <UserAvatar name={u.displayName} className="size-8" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {u.displayName}
                        {u.orgRole === 'org_admin' ? <Badge>Admin</Badge> : null}
                      </ItemTitle>
                      <ItemDescription>{ROLE_HINT[u.email] ?? u.email}</ItemDescription>
                    </ItemContent>
                    <ItemActions>{busyEmail === u.email ? <Spinner /> : <ChevronRight className="size-4 text-muted-foreground" />}</ItemActions>
                  </button>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        Production sign-in uses Microsoft Entra ID. This picker exists only in local development.
      </FieldDescription>
    </div>
  )
}
