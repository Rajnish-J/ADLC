'use client'

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveConnection } from '@/components/providers/LiveEventsProvider'
import { cn } from '@/lib/utils'

/** "Live" while the SSE stream is connected — changes from VS Code or other people appear without a reload. */
export function LiveIndicator() {
  const connected = useLiveConnection()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
          <span className="relative flex size-2">
            {connected ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /> : null}
            <span className={cn('relative inline-flex size-2 rounded-full', connected ? 'bg-success' : 'bg-muted-foreground/50')} />
          </span>
          {connected ? 'Live' : 'Offline'}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {connected ? 'Receiving live updates from the platform' : 'Reconnecting to live updates…'}
      </TooltipContent>
    </Tooltip>
  )
}
