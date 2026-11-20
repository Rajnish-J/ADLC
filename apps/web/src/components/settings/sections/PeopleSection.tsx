'use client'

// Settings → People (org admins): everyone in the organization, their projects and roles, and who is an org admin.

import { useState } from 'react'
import { Search, ShieldCheck, ShieldOff } from 'lucide-react'
import { PROJECT_ROLE_LABELS } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'

export default function PeopleSection() {
  const { me } = ST.useSession()
  const { data, error, loading, setData } = ST.usePeople(true)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function setRole(userId: string, orgRole: 'org_admin' | 'member', name: string): Promise<void> {
    setBusy(userId)
    try {
      setData(await ST.setOrgRole(userId, orgRole))
      UI.toast.success(orgRole === 'org_admin' ? `${name} is now an org admin` : `${name} is no longer an org admin`)
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not change the role.')
    } finally {
      setBusy(null)
    }
  }

  if (error) return <UI.ErrorAlert title="Could not load the people" message={error.message} />
  if (loading || !data) return <UI.Skeleton className="h-64 rounded-xl" />

  const q = search.trim().toLowerCase()
  const people = q ? data.people.filter((p) => `${p.user.displayName} ${p.user.email}`.toLowerCase().includes(q)) : data.people
  const admins = data.people.filter((p) => p.user.orgRole === 'org_admin').length

  return (
    <>
      <SectionHeader
        title="People"
        description={`Everyone in ${data.organization.name}. Org admins see every project, create projects and manage these settings. People appear here when they first sign in.`}
      />
      <UI.StatCards
        items={[
          { label: 'People', value: data.people.length, footer: { title: 'In the organization' } },
          { label: 'Org admins', value: admins, footer: { title: 'At least one is always kept' } },
          { label: 'Not on a project', value: data.people.filter((p) => p.projects.length === 0).length, footer: { title: 'Add them from a project’s Members' } },
        ]}
      />
      <UI.InputGroup className="w-full sm:w-72">
        <UI.InputGroupAddon>
          <Search />
        </UI.InputGroupAddon>
        <UI.InputGroupInput placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </UI.InputGroup>
      <UI.Card className="py-0">
        <UI.ItemGroup>
          {people.map((p, i) => {
            const isAdmin = p.user.orgRole === 'org_admin'
            const isMe = p.user.id === me?.user.id
            return (
              <div key={p.user.id}>
                {i > 0 ? <UI.ItemSeparator /> : null}
                <UI.Item size="sm" className="rounded-none border-0 px-4">
                  <UI.ItemMedia>
                    <UI.UserAvatar name={p.user.displayName} className="size-8" />
                  </UI.ItemMedia>
                  <UI.ItemContent>
                    <UI.ItemTitle className="flex flex-wrap items-center gap-2">
                      {p.user.displayName}
                      {isMe ? <span className="text-xs font-normal text-muted-foreground">(you)</span> : null}
                      {isAdmin ? <UI.Badge>Org admin</UI.Badge> : null}
                    </UI.ItemTitle>
                    <UI.ItemDescription>
                      {p.user.email}
                      {p.lastSeenAt ? ` · last seen ${UI.relativeTime(p.lastSeenAt)}` : ''}
                    </UI.ItemDescription>
                    {p.projects.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.projects.map((pr) => (
                          <UI.Badge key={pr.key} variant="outline" className="font-normal">
                            <span className="font-mono">{pr.key}</span> {PROJECT_ROLE_LABELS[pr.role]}
                          </UI.Badge>
                        ))}
                      </div>
                    ) : null}
                  </UI.ItemContent>
                  <UI.ItemActions>
                    {isAdmin ? (
                      <UI.Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === p.user.id || admins <= 1}
                        title={admins <= 1 ? 'The organization needs at least one org admin' : undefined}
                        onClick={() => void setRole(p.user.id, 'member', p.user.displayName)}
                      >
                        <ShieldOff /> Remove admin
                      </UI.Button>
                    ) : (
                      <UI.Button variant="outline" size="sm" disabled={busy === p.user.id} onClick={() => void setRole(p.user.id, 'org_admin', p.user.displayName)}>
                        <ShieldCheck /> Make org admin
                      </UI.Button>
                    )}
                  </UI.ItemActions>
                </UI.Item>
              </div>
            )
          })}
        </UI.ItemGroup>
      </UI.Card>
    </>
  )
}
