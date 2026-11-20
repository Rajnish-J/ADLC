'use client'

// Org admins: archived projects, with Restore.

import { ArchiveRestore } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

export default function ArchivedProjectsCard() {
  const { data, setData } = ST.useArchivedProjects(true)
  if (!data || data.length === 0) return null

  async function restore(id: string, label: string): Promise<void> {
    try {
      setData(await ST.restoreProject(id))
      UI.toast.success(`Restored ${label}`)
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not restore the project.')
    }
  }

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Archived projects</UI.CardTitle>
        <UI.CardDescription>Hidden from everyone. Restoring brings a project back exactly as it was.</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <ul className="flex flex-col divide-y">
          {data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <UI.KeyTile projectKey={p.key} />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground"> · archived {UI.relativeTime(p.archivedAt)}</span>
              </span>
              <UI.Button variant="outline" size="sm" onClick={() => void restore(p.id, `${p.key} · ${p.name}`)}>
                <ArchiveRestore /> Restore
              </UI.Button>
            </li>
          ))}
        </ul>
      </UI.CardContent>
    </UI.Card>
  )
}
