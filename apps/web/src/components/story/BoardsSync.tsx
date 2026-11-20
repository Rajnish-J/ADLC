'use client'

// The "Sync from Azure DevOps" button and the quiet note for problems in the automatic sync — shared by My stories
// and the project board (the sync itself is useBoardsSync).

import { CircleAlert, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { BoardsSync } from '@/hooks/story/useBoardsSync'

/** "Sync from Azure DevOps": pulls the work items assigned to you into their linked projects. */
export function BoardsSyncButton({ boards }: { boards: BoardsSync }) {
  return (
    <Button variant="outline" onClick={() => void boards.sync(true)} disabled={boards.syncing}>
      {boards.syncing ? <Spinner /> : <RefreshCw />} Sync from Azure DevOps
    </Button>
  )
}

/** What went wrong in the automatic sync — a quiet line, not a toast. */
export function BoardsSyncWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" /> Azure DevOps sync: {w}
        </p>
      ))}
    </div>
  )
}
