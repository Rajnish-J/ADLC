'use client'

import { useMemo } from 'react'
import * as UI from '@/imports/UI.imports'
import * as P from '@/imports/project.imports'

const ROLE_HELP: Record<P.ProjectRole, string> = {
  owner: 'Runs the project: settings, members, stories and approvals.',
  lead: 'Writes and assigns stories, approves work, manages developers and viewers.',
  developer: 'Picks up ready stories and works on them with the agents.',
  viewer: 'Read-only access to the board and activity.',
}

function Members({ project }: { project: P.ProjectDetail }) {
  const { setData } = P.useCurrentProject()
  const columns = useMemo(() => P.memberColumns(project, setData), [project, setData])
  const canManage = project.permissions.includes('project.manage_members')

  return (
    <div className="grid gap-6 @5xl/main:grid-cols-[1fr_300px]">
      <UI.DataTable
        columns={columns}
        data={project.members}
        searchColumn="member"
        searchPlaceholder="Search members…"
        toolbar={canManage ? <P.AddMemberDialog project={project} onChange={setData} /> : null}
        initialSorting={[{ id: 'role', desc: false }]}
      />
      <UI.Card className="h-fit">
        <UI.CardHeader>
          <UI.CardTitle>Roles</UI.CardTitle>
          <UI.CardDescription>
            {canManage ? `You can grant: ${project.assignableRoles.map((r) => P.PROJECT_ROLE_LABELS[r]).join(', ')}.` : 'Only owners and leads manage members.'}
          </UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          <UI.ItemGroup>
            {P.PROJECT_ROLES.map((r) => (
              <UI.Item key={r} size="sm" className="px-0">
                <UI.ItemContent>
                  <UI.ItemTitle>
                    <UI.Badge variant={P.ROLE_VARIANT[r]}>{P.PROJECT_ROLE_LABELS[r]}</UI.Badge>
                  </UI.ItemTitle>
                  <UI.ItemDescription className="line-clamp-none">{ROLE_HELP[r]}</UI.ItemDescription>
                </UI.ItemContent>
              </UI.Item>
            ))}
          </UI.ItemGroup>
        </UI.CardContent>
      </UI.Card>
    </div>
  )
}

export default function MembersContainer() {
  return (
    <P.ProjectShell title="Members" description="Who works on this project and what each role can do.">
      {(project) => <Members project={project} />}
    </P.ProjectShell>
  )
}
