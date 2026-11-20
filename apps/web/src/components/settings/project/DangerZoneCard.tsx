'use client'

// Archive a project (owners and org admins). It disappears for everyone; an org admin can restore it from
// Settings → Project settings → Archived projects.

import { useRouter } from 'next/navigation'
import { Archive } from 'lucide-react'
import type { ProjectDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

export default function DangerZoneCard({ project }: { project: ProjectDetail }) {
  const router = useRouter()
  if (!project.permissions.includes('project.update')) return null

  async function archive(): Promise<void> {
    try {
      await ST.archiveProject(project.key)
      UI.toast.success(`Archived ${project.key} · ${project.name}`, { description: 'An org admin can restore it from Settings → Archived projects.' })
      router.replace('/')
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not archive the project.')
    }
  }

  return (
    <UI.Card className="border-destructive/40">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Danger zone</UI.CardTitle>
        <UI.CardDescription>Archiving hides the project — its board, code, memory and activity — from everyone. Nothing is deleted.</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <UI.AlertDialog>
          <UI.AlertDialogTrigger asChild>
            <UI.Button variant="destructive" size="sm">
              <Archive /> Archive {project.key}
            </UI.Button>
          </UI.AlertDialogTrigger>
          <UI.AlertDialogContent>
            <UI.AlertDialogHeader>
              <UI.AlertDialogTitle>
                Archive {project.key} · {project.name}?
              </UI.AlertDialogTitle>
              <UI.AlertDialogDescription>
                Everyone loses access to it until an org admin restores it. Its stories, memory, code and history are kept.
              </UI.AlertDialogDescription>
            </UI.AlertDialogHeader>
            <UI.AlertDialogFooter>
              <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
              <UI.AlertDialogAction variant="destructive" onClick={() => void archive()}>
                Archive
              </UI.AlertDialogAction>
            </UI.AlertDialogFooter>
          </UI.AlertDialogContent>
        </UI.AlertDialog>
      </UI.CardContent>
    </UI.Card>
  )
}
