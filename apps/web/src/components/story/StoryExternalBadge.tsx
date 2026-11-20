'use client'

// The "ADO #1234" badge on a story synced from Azure Boards: links to the work item (new tab) and shows its type
// and Azure DevOps state on hover. Clicks and key presses stay on the badge so they don't open or drag the story.

import { ExternalLink } from 'lucide-react'
import { externalLabel, type Story } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export function StoryExternalBadge({ story, className }: { story: Pick<Story, 'external'>; className?: string }) {
  const ext = story.external
  if (!ext) return null
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <Badge variant="outline" asChild className={cn('font-mono text-[10px] text-muted-foreground', className)}>
      <a
        href={ext.url}
        target="_blank"
        rel="noreferrer"
        title={`${ext.type} · ${ext.state}`}
        onClick={stop}
        onPointerDown={stop}
        onKeyDown={stop}
      >
        {externalLabel(ext)}
        <ExternalLink />
      </a>
    </Badge>
  )
}
