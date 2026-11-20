'use client'

// Every version of the project profile: how it was made (generated, or folded in from runs), its decision, and
// its content. Any version can be downloaded.

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, History } from 'lucide-react'
import type { ProfileVersionSummary } from '@sdlc/contracts'
import { useProfileVersion, useProfileVersions } from '@/hooks/memory/useProjectProfile'
import * as UI from '@/imports/UI.imports'
import { profileDownloadUrl } from '@/service/profile.service'
import ProfileView, { StackChips } from './ProfileView'

const STATUS_VARIANT: Record<ProfileVersionSummary['status'], 'success' | 'warning' | 'outline' | 'destructive' | 'secondary'> = {
  accepted: 'success',
  proposed: 'warning',
  generating: 'secondary',
  superseded: 'outline',
  rejected: 'outline',
  failed: 'destructive',
}

export default function ProfileHistorySheet({ projectKey, trigger, initialVersion }: { projectKey: string; trigger: ReactNode; initialVersion?: number }) {
  const [open, setOpen] = useState(false)
  const versions = useProfileVersions(projectKey, open)
  const [selected, setSelected] = useState<string | null>(null)
  const list = versions.data ?? []
  const id =
    selected ??
    (initialVersion !== undefined ? list.find((v) => v.version === initialVersion)?.id : undefined) ??
    list.find((v) => v.status === 'accepted')?.id ??
    list[0]?.id ??
    null
  const version = useProfileVersion(projectKey, open ? id : null)

  return (
    <UI.Sheet open={open} onOpenChange={setOpen}>
      <UI.SheetTrigger asChild>{trigger}</UI.SheetTrigger>
      <UI.SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-4xl">
        <UI.SheetHeader className="border-b">
          <UI.SheetTitle className="flex items-center gap-2">
            <History className="size-4" /> Project profile history
          </UI.SheetTitle>
          <UI.SheetDescription>Each generation and each update folded in from runs is a version. The accepted one is given to agents.</UI.SheetDescription>
        </UI.SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[16rem_1fr]">
          <div className="overflow-y-auto border-b p-2 md:border-r md:border-b-0">
            {versions.loading && !versions.data ? <UI.Skeleton className="h-40" /> : null}
            {list.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelected(v.id)}
                className={UI.cn('flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left text-sm hover:bg-muted', v.id === id && 'bg-muted')}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="font-medium">v{v.version}</span>
                  <UI.Badge variant={STATUS_VARIANT[v.status]} className="capitalize">
                    {v.status}
                  </UI.Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {v.trigger === 'run' ? `From ${v.runIds.length} run${v.runIds.length === 1 ? '' : 's'}` : `Generated${v.createdBy ? ` by ${v.createdBy.displayName}` : ''}`} · {UI.relativeTime(v.createdAt)}
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 overflow-y-auto p-4">
            {version.data?.content ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">{version.data.content.headline}</p>
                    <p className="text-xs text-muted-foreground">
                      {version.data.branch ? `${version.data.branch}${version.data.commitSha ? ` @ ${version.data.commitSha.slice(0, 7)}` : ''} · ` : ''}
                      {version.data.aiWritten ? (version.data.model ?? 'AI') : 'Counted facts only'}
                      {version.data.decidedBy ? ` · ${version.data.status === 'rejected' ? 'rejected' : 'accepted'} by ${version.data.decidedBy.displayName}` : ''}
                    </p>
                    {version.data.decisionComment ? <p className="text-xs text-muted-foreground">“{version.data.decisionComment}”</p> : null}
                  </div>
                  <UI.Button asChild variant="outline" size="sm">
                    <a href={profileDownloadUrl(projectKey, version.data.id)}>
                      <Download /> Download .md
                    </a>
                  </UI.Button>
                </div>
                <StackChips content={version.data.content} />
                {version.data.runIds.length ? (
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="text-muted-foreground">Runs:</span>
                    {version.data.runIds.map((r) => (
                      <Link key={r} href={`/projects/${encodeURIComponent(projectKey)}/workflow/runs/${r}`} className="font-mono text-primary hover:underline">
                        {r.slice(0, 8)}
                      </Link>
                    ))}
                  </div>
                ) : null}
                <ProfileView content={version.data.content} projectKey={projectKey} branch={version.data.branch} />
              </div>
            ) : version.data?.error ? (
              <UI.ErrorAlert title="This version failed" message={version.data.error} />
            ) : list.length === 0 && !versions.loading ? (
              <UI.EmptyState title="No versions yet" description="Generate the profile from the repository to start its history." />
            ) : (
              <UI.Skeleton className="h-64" />
            )}
          </div>
        </div>
      </UI.SheetContent>
    </UI.Sheet>
  )
}
