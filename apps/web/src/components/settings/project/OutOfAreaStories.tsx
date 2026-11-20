'use client'

// Under the Azure Boards link, once an area is saved: the stories synced from work items outside that area (e.g.
// imported before the area was set), with "Remove" behind a confirmation. Owners only; the server re-checks.

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { BoardsPruneResult } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { pruneProjectBoards } from '@/service/boards.service'

const areaLabel = (path: string): string => (path.includes('\\') ? path.slice(path.indexOf('\\') + 1) : path)

export default function OutOfAreaStories({ projectKey, areaPath }: { projectKey: string; areaPath: string }) {
  const [result, setResult] = useState<BoardsPruneResult | null>(null)
  const [removing, setRemoving] = useState(false)

  const check = useCallback(async () => {
    try {
      setResult(await pruneProjectBoards(projectKey, true))
    } catch {
      setResult(null) // No access to Azure DevOps right now: nothing to offer.
    }
  }, [projectKey])

  useEffect(() => {
    setResult(null)
    void check()
  }, [check, areaPath])

  async function remove(): Promise<void> {
    setRemoving(true)
    try {
      const res = await pruneProjectBoards(projectKey, false)
      UI.toast.success(`Removed ${res.stories.length} ${res.stories.length === 1 ? 'story' : 'stories'} from other areas`)
      setResult({ ...res, stories: [] })
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not remove the stories.')
    } finally {
      setRemoving(false)
    }
  }

  if (!result || result.stories.length === 0) return null
  const n = result.stories.length
  const noun = n === 1 ? 'story' : 'stories'

  return (
    <UI.Alert>
      <UI.AlertTitle>
        {n} synced {noun} {n === 1 ? 'is' : 'are'} from other areas
      </UI.AlertTitle>
      <UI.AlertDescription>
        <p>
          They were imported before this project was limited to <span className="font-medium">{areaLabel(result.areaPath)}</span>. Syncing won’t bring them
          back while the area is set.
        </p>
        <UI.AlertDialog>
          <UI.AlertDialogTrigger asChild>
            <UI.Button variant="outline" size="sm" className="mt-2" disabled={removing}>
              {removing ? <UI.Spinner /> : <Trash2 />} Remove {n} {noun}
            </UI.Button>
          </UI.AlertDialogTrigger>
          <UI.AlertDialogContent>
            <UI.AlertDialogHeader>
              <UI.AlertDialogTitle>
                Remove {n} {noun} from {projectKey}?
              </UI.AlertDialogTitle>
              <UI.AlertDialogDescription>
                This permanently deletes the {noun} and everything on the platform that belongs to {n === 1 ? 'it' : 'them'}:{' '}
                <span className="font-medium text-foreground">
                  {result.runs > 0 ? `${result.runs} ${result.runs === 1 ? 'run' : 'runs'}` : 'any runs'} and their history
                </span>{' '}
                (steps, events, changes, evaluations and the memory each run used), tasks, commits and Activity. Memory captured from{' '}
                {n === 1 ? 'it' : 'them'} stays but is no longer linked to a story. This can’t be undone. The work items stay in Azure DevOps.
              </UI.AlertDialogDescription>
            </UI.AlertDialogHeader>
            <ul className="max-h-60 overflow-y-auto rounded-md border text-sm">
              {result.stories.map((s) => (
                <li key={s.number} className="flex gap-2 border-b px-3 py-1.5 last:border-b-0">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {projectKey}-{s.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{areaLabel(s.areaPath)}</span>
                </li>
              ))}
            </ul>
            <UI.AlertDialogFooter>
              <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
              <UI.AlertDialogAction onClick={() => void remove()}>Remove</UI.AlertDialogAction>
            </UI.AlertDialogFooter>
          </UI.AlertDialogContent>
        </UI.AlertDialog>
      </UI.AlertDescription>
    </UI.Alert>
  )
}
