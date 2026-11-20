'use client'

// First step of New project: start blank or import, plus the projects this browser opened lately.

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { FolderInput, Plus } from 'lucide-react'
import type { ProjectSummary } from '@sdlc/contracts'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useProjects } from '@/hooks/project/useProjects'
import { relativeTime } from '@/utils/format'
import { recentProjects } from '@/utils/recentProjects'

function Choice({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-36 flex-col items-center justify-center gap-3 rounded-xl border bg-card px-4 text-center transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {icon}
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

function JumpBackIn({ onNavigate }: { onNavigate: () => void }) {
  const { data } = useProjects()
  const recent = useMemo(() => {
    const byKey = new Map((data ?? []).map((p) => [p.key, p]))
    return recentProjects()
      .map((r) => ({ visit: r, project: byKey.get(r.key) }))
      .filter((r): r is { visit: (typeof r)['visit']; project: ProjectSummary } => Boolean(r.project))
      .slice(0, 3)
  }, [data])
  if (recent.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="mb-1 text-sm text-muted-foreground">Jump back in</p>
      {recent.map(({ visit, project }) => (
        <Link
          key={project.key}
          href={`/projects/${encodeURIComponent(project.key)}`}
          onClick={onNavigate}
          className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="flex h-5 min-w-8 items-center justify-center rounded bg-primary/10 px-1 font-mono text-[10px] font-semibold text-primary">{project.key}</span>
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(visit.at)}</span>
        </Link>
      ))}
    </div>
  )
}

export default function ChooseView({ onBlank, onImport, onNavigate }: { onBlank: () => void; onImport: () => void; onNavigate: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle className="text-xl">New Project</DialogTitle>
        <DialogDescription className="sr-only">Start a blank project or import an existing repository.</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Choice
          onClick={onBlank}
          label="Blank project"
          hint="Start from an empty workspace"
          icon={
            <span className="flex size-9 items-center justify-center rounded-full bg-foreground text-background">
              <Plus className="size-5" />
            </span>
          }
        />
        <Choice onClick={onImport} label="Import" hint="Bring in an existing repository" icon={<FolderInput className="size-7 text-foreground" strokeWidth={1.6} />} />
      </div>
      <JumpBackIn onNavigate={onNavigate} />
    </div>
  )
}
