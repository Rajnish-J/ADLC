'use client'

// The organisation's Azure Git connections offered for My work items: "Use" on the ones whose token is mine; the
// others say whose token they hold (it would show that person's work items).

import { FolderGit2 } from 'lucide-react'
import type { AdoConnectionSuggestion } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { cn } from '@/lib/utils'

interface Props {
  suggestions: AdoConnectionSuggestion[]
  linking: string | null
  onUse: (connectionId: string) => void
  className?: string
}

export default function AdoConnectionSuggestions({ suggestions, linking, onUse, className }: Props) {
  if (suggestions.length === 0) return null
  return (
    <ul className={cn('flex flex-col divide-y rounded-lg border text-left', className)}>
      {suggestions.map((s) => (
        <li key={s.connectionId} className="flex items-center gap-3 px-3 py-2.5">
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{s.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              dev.azure.com/{s.organization} · token {s.hint}
              {s.account ? ` · ${s.account}` : ''}
            </span>
            {s.usable ? null : <span className="text-xs text-muted-foreground">{s.reason}</span>}
          </div>
          {s.usable ? (
            <UI.Button size="sm" onClick={() => onUse(s.connectionId)} disabled={linking !== null}>
              {linking === s.connectionId ? <UI.Spinner /> : null} Use this connection
            </UI.Button>
          ) : (
            <UI.Badge variant="outline">Not yours</UI.Badge>
          )}
        </li>
      ))}
    </ul>
  )
}
