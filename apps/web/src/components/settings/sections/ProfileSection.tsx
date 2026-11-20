'use client'

// Settings → Profile: who you are (from sign-in), your projects and roles, and switching user.

import Link from 'next/link'
import { LogOut } from 'lucide-react'
import { PROJECT_ROLE_LABELS } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'
import AdoTokenCard from './AdoTokenCard'
import BoardsIdentityCard from './BoardsIdentityCard'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[160px_1fr] sm:items-center">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

export default function ProfileSection() {
  const { me, signOut } = ST.useSession()
  const { data: projects } = ST.useProjects()
  if (!me) return null
  const isAdmin = me.user.orgRole === 'org_admin'
  return (
    <>
      <SectionHeader title="Profile" description="Your account comes from sign-in, so your name and email are managed there." />
      <UI.Card>
        <UI.CardContent className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <UI.UserAvatar name={me.user.displayName} className="size-12 [&_span]:text-sm" />
            <div>
              <p className="text-base font-medium">{me.user.displayName}</p>
              <p className="text-sm text-muted-foreground">{me.user.email}</p>
            </div>
          </div>
          <UI.Separator />
          <dl className="flex flex-col gap-3">
            <Fact label="Organization role">
              <UI.Badge variant={isAdmin ? 'default' : 'secondary'}>{isAdmin ? 'Org admin' : 'Member'}</UI.Badge>
            </Fact>
            <Fact label="Can create projects">{me.canCreateProject ? 'Yes' : 'No — org admins create projects'}</Fact>
            <Fact label="Sign-in">
              <span className="text-muted-foreground">Development sign-in (a seeded user). Production uses Microsoft Entra ID.</span>
            </Fact>
          </dl>
          <div>
            <UI.Button variant="outline" size="sm" onClick={() => void signOut()}>
              <LogOut /> Switch user
            </UI.Button>
          </div>
        </UI.CardContent>
      </UI.Card>

      <AdoTokenCard />

      <BoardsIdentityCard />

      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Your projects</UI.CardTitle>
          <UI.CardDescription>Your role decides what you can change in each project.</UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          {!projects ? (
            <UI.Skeleton className="h-16" />
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">You aren’t on any project yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <UI.KeyTile projectKey={p.key} />
                  <Link href={`/projects/${p.key}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.myRole ? <UI.Badge variant={ST.ROLE_VARIANT[p.myRole]}>{PROJECT_ROLE_LABELS[p.myRole]}</UI.Badge> : <UI.Badge variant="outline">Admin access</UI.Badge>}
                </li>
              ))}
            </ul>
          )}
        </UI.CardContent>
      </UI.Card>
    </>
  )
}
