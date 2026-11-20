'use client'

// Azure Boards: sync my assigned work items into stories (the "Sync from Azure DevOps" button and the quiet sync
// when My stories or a board opens), plus a project's Boards link and my Azure DevOps identity for Settings.
// A manual sync toasts every problem; the automatic one keeps them as warnings the page shows inline.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { BoardsIdentity, BoardsSyncResponse, ProjectBoards } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getBoardsIdentity, getProjectBoards } from '@/service/boards.service'
import { syncMyStories, syncProjectStories } from '@/service/story.service'

/** A project's Azure Boards link. Refreshes when the project changes (saving the link publishes that). */
export function useProjectBoards(key: string): ApiResource<ProjectBoards> {
  return useApiResource(() => getProjectBoards(key), [key], (e) => e.type === 'project.changed' && e.projectKey === key)
}

/** The identity my Azure DevOps work items are matched against, and my override. */
export function useBoardsIdentity(): ApiResource<BoardsIdentity> {
  return useApiResource(getBoardsIdentity, [])
}

const NOT_LINKED = 'No project you’re on is linked to Azure Boards yet. A project owner can link one in Project settings › Azure Boards.'

/** "Synced from Azure DevOps: 2 new stories, 3 updated", or null when nothing changed. */
function summary(res: BoardsSyncResponse): string | null {
  const created = res.results.reduce((n, r) => n + r.created, 0)
  const updated = res.results.reduce((n, r) => n + r.updated, 0)
  if (created + updated === 0) return null
  const parts = [created ? `${created} new ${created === 1 ? 'story' : 'stories'}` : null, updated ? `${updated} updated` : null]
  return `Synced from Azure DevOps: ${parts.filter(Boolean).join(', ')}`
}

export interface BoardsSync {
  syncing: boolean
  /** Problems from the last automatic sync, for a quiet inline note (a manual sync toasts them instead). */
  warnings: string[]
  /** Run a sync now. `manual` forces past the server's throttle and reports everything as toasts. */
  sync: (manual: boolean) => Promise<void>
}

interface Options {
  /** Sync just this project (always runs); omitted → every linked project I'm on. */
  projectKey?: string
  /** Run one automatic sync when this turns true (once per mount and project). */
  auto: boolean
  /** Called after a sync that created or updated stories, to reload the list. */
  onSynced?: () => Promise<void> | void
}

export function useBoardsSync({ projectKey, auto, onSynced }: Options): BoardsSync {
  const [syncing, setSyncing] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const running = useRef(false)

  const sync = useCallback(
    async (manual: boolean) => {
      if (running.current) return
      running.current = true
      setSyncing(true)
      try {
        const res = projectKey ? await syncProjectStories(projectKey) : await syncMyStories(manual)
        const done = summary(res)
        if (done) {
          toast.success(done)
          await onSynced?.()
        }
        const failed = res.results.filter((r) => r.error)
        if (manual) {
          setWarnings([])
          for (const r of failed) toast.error(`Could not sync ${r.projectKey}`, { description: r.error })
          if (res.results.length === 0 && !res.throttled) toast.info(NOT_LINKED)
          else if (!done && failed.length === 0) toast.success('Up to date with Azure DevOps')
        } else {
          setWarnings(failed.map((r) => (projectKey ? (r.error ?? '') : `${r.projectKey}: ${r.error}`)))
        }
      } catch (err) {
        const message = err instanceof AppError ? err.message : 'Could not sync from Azure DevOps.'
        if (manual) toast.error(message)
        else setWarnings([message])
      } finally {
        running.current = false
        setSyncing(false)
      }
    },
    [projectKey, onSynced],
  )

  // One automatic sync per mount (and per project): the ref survives React's dev double-effect.
  const autoRan = useRef<string | null>(null)
  useEffect(() => {
    const id = projectKey ?? '*'
    if (!auto || autoRan.current === id) return
    autoRan.current = id
    void sync(false)
  }, [auto, projectKey, sync])

  return { syncing, warnings, sync }
}
