'use client'

import { useState } from 'react'
import { History } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'

const ALL = 'all'

function Activity({ projectKey }: { projectKey: string }) {
  const { data: entries, error, loading } = C.useActivity(projectKey)
  const [client, setClient] = useState<string>(ALL)
  const [actor, setActor] = useState<string>(ALL)

  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading || !entries) return <UI.Skeleton className="h-96 rounded-xl" />
  if (entries.length === 0) return <UI.EmptyState icon={<History />} title="No activity yet" />

  const clients = [...new Set(entries.map((e) => e.via))]
  const actors = [...new Set(entries.map((e) => e.actor?.displayName ?? 'System'))].sort()
  const shown = entries.filter(
    (e) => (client === ALL || e.via === client) && (actor === ALL || (e.actor?.displayName ?? 'System') === actor),
  )

  return (
    <UI.DataTable
      columns={C.activityColumns}
      data={shown}
      searchColumn="activity"
      searchPlaceholder="Search activity…"
      pageSize={20}
      initialSorting={[{ id: 'when', desc: true }]}
      toolbar={
        <>
          <UI.Select value={client} onValueChange={setClient}>
            <UI.SelectTrigger className="w-36" aria-label="Client">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              <UI.SelectItem value={ALL}>All clients</UI.SelectItem>
              {clients.map((c) => (
                <UI.SelectItem key={c} value={c}>
                  {C.CLIENT_LABELS[c] ?? c}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
          <UI.Select value={actor} onValueChange={setActor}>
            <UI.SelectTrigger className="w-44" aria-label="Who">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              <UI.SelectItem value={ALL}>Everyone</UI.SelectItem>
              {actors.map((a) => (
                <UI.SelectItem key={a} value={a}>
                  {a}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
        </>
      }
    />
  )
}

export default function ActivityContainer() {
  return (
    <C.ProjectShell title="Activity" description="Every change in this project — who made it, and from which client.">
      {(project) =>
        project.permissions.includes('audit.view') ? (
          <Activity projectKey={project.key} />
        ) : (
          <UI.ErrorAlert title="Not available" message="Only leads, owners and admins can see a project's activity." />
        )
      }
    </C.ProjectShell>
  )
}
