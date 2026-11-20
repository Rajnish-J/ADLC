'use client'

// The project knowledge an agent working on a story is given besides the story's own memory: pinned items and the
// project's conventions and decisions.

import Link from 'next/link'
import { Pin } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import { useProjectMemory } from '@/hooks/memory/useMemory'
import { KIND_META } from './memory-meta'

export default function ProjectKnowledgeCard({ projectKey }: { projectKey: string }) {
  const { data, loading } = useProjectMemory(projectKey, { status: 'accepted' })
  const items = (data ?? [])
    .filter((m) => m.pinned || m.kind === 'convention' || m.kind === 'decision')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    .slice(0, 8)

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle>Project knowledge</UI.CardTitle>
        <UI.CardDescription>Also given to agents on this story.</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3">
        {loading && !data ? (
          <UI.Skeleton className="h-24" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No conventions or decisions recorded for the project yet.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {items.map((m) => {
              const Icon = KIND_META[m.kind].icon
              return (
                <li key={m.id} className="flex items-start gap-2 text-sm">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 leading-snug" title={m.content}>
                    {m.title}
                  </span>
                  {m.pinned ? <Pin className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="Pinned" /> : null}
                </li>
              )
            })}
          </ul>
        )}
        <Link href={`/projects/${projectKey}/memory`} className="text-xs font-medium text-primary hover:underline">
          Open project memory
        </Link>
      </UI.CardContent>
    </UI.Card>
  )
}
