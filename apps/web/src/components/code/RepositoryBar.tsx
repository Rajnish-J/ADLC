'use client'

// The strip above the workbench: which repository, its sync state, Sync, the sync history and (owners) settings.
// A workspace (blank project, no remote) shows Publish to GitHub instead of the sync controls.

import { useState } from 'react'
import { AlertTriangle, CircleCheck, ExternalLink, History, KeyRound, RefreshCw, Settings2, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { REPO_PROVIDER_LABELS, type ProjectDetail, type ProjectRepository, type RepoSync } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useSyncs } from '@/hooks/code/useCode'
import { syncRepository } from '@/service/code.service'
import { dateTime, relativeTime } from '@/utils/format'
import ProviderIcon from './ProviderIcon'
import PublishWorkspaceDialog from './PublishWorkspaceDialog'
import Link from 'next/link'

const TRIGGER_LABELS: Record<RepoSync['trigger'], string> = {
  link: 'First clone',
  manual: 'Sync',
  branch: 'Opened a branch',
  commit: 'After a commit',
  startup: 'Resumed after restart',
}

function SyncRow({ sync }: { sync: RepoSync }) {
  const branches = sync.stats?.branches ?? []
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-2 text-sm">
        {sync.status === 'succeeded' ? (
          <CircleCheck className="size-4 text-success" />
        ) : sync.status === 'failed' ? (
          <AlertTriangle className="size-4 text-destructive" />
        ) : (
          <Spinner className="size-4" />
        )}
        <span className="font-medium">{TRIGGER_LABELS[sync.trigger]}</span>
        {sync.branch ? <span className="font-mono text-xs text-muted-foreground">{sync.branch}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground" title={dateTime(sync.createdAt)}>
          {relativeTime(sync.createdAt)}
        </span>
      </div>
      {sync.requestedBy ? <p className="text-xs text-muted-foreground">by {sync.requestedBy}</p> : null}
      {sync.error ? <p className="text-xs text-destructive">{sync.error}</p> : null}
      {branches.map((b) => (
        <p key={b.name} className="text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{b.name}</span> · {b.files} files ({b.stored} stored) · +{b.added} ~{b.changed} −{b.removed}
          {b.ignored ? (
            <span title={b.ignoredSamples.join('\n')}>
              {' '}
              · {b.ignored} ignored by .gitignore
            </span>
          ) : null}
        </p>
      ))}
      {sync.stats?.catalog ? (
        <p className="text-xs text-muted-foreground">
          {sync.stats.catalog.agents} agents, {sync.stats.catalog.skills} skills
          {sync.stats.catalog.added + sync.stats.catalog.updated + sync.stats.catalog.removed > 0
            ? ` (+${sync.stats.catalog.added} ~${sync.stats.catalog.updated} −${sync.stats.catalog.removed})`
            : ''}
        </p>
      ) : null}
    </li>
  )
}

function SyncHistory({ projectKey, open, onOpenChange }: { projectKey: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, loading } = useSyncs(projectKey, open)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Sync history</SheetTitle>
          <SheetDescription>Clones, syncs and branch loads — what changed and what .gitignore left out.</SheetDescription>
        </SheetHeader>
        <ul className="overflow-y-auto px-4">
          {loading && !data ? <Spinner /> : (data ?? []).map((s) => <SyncRow key={s.id} sync={s} />)}
        </ul>
      </SheetContent>
    </Sheet>
  )
}

function WorkspaceBar({ project, repo }: { project: ProjectDetail; repo: ProjectRepository }) {
  const [publishing, setPublishing] = useState(false)
  const canManage = project.permissions.includes('repo.manage')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <ProviderIcon provider={repo.provider} className="text-muted-foreground" />
        <span className="truncate font-medium">{repo.displayName}</span>
        <Badge variant="outline">Workspace</Badge>
        <span className="hidden text-xs text-muted-foreground sm:inline">Kept on the platform · not published yet</span>
      </span>
      {canManage ? (
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setPublishing(true)}>
            <UploadCloud /> Publish to GitHub
          </Button>
        </div>
      ) : null}
      <PublishWorkspaceDialog project={project} open={publishing} onOpenChange={setPublishing} />
    </div>
  )
}

export default function RepositoryBar({ project, repo }: { project: ProjectDetail; repo: ProjectRepository }) {
  if (repo.provider === 'workspace') return <WorkspaceBar project={project} repo={repo} />
  return <LinkedRepositoryBar project={project} repo={repo} />
}

function LinkedRepositoryBar({ project, repo }: { project: ProjectDetail; repo: ProjectRepository }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const canSync = project.permissions.includes('code.edit')
  const canManage = project.permissions.includes('repo.manage')
  const syncing = repo.activeSync !== null

  async function sync(): Promise<void> {
    setRequesting(true)
    try {
      await syncRepository(project.key)
      toast.success('Sync started', { description: 'Branches, files, agents and skills update as soon as it finishes.' })
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'Could not start a sync.')
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <ProviderIcon provider={repo.provider} className="text-muted-foreground" />
        <span className="truncate font-mono text-xs" title={repo.remoteUrl}>
          {repo.displayName}
        </span>
        <Badge variant="outline" className="hidden sm:inline-flex">
          {REPO_PROVIDER_LABELS[repo.provider]}
        </Badge>
        {repo.credential.source === 'connection' ? (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground lg:inline-flex" title="Access comes from this Git connection">
            <KeyRound className="size-3.5" /> {repo.credential.connectionName}
          </span>
        ) : null}
      </span>
      {syncing ? (
        <Badge variant="secondary">
          <Spinner className="size-3" /> {repo.activeSync?.branch ? `Loading ${repo.activeSync.branch}` : 'Syncing'}
        </Badge>
      ) : repo.status === 'failed' ? (
        <Badge variant="destructive" title={repo.lastError ?? undefined}>
          <AlertTriangle /> Last sync failed
        </Badge>
      ) : repo.lastSyncedAt ? (
        <span className="text-xs text-muted-foreground" title={dateTime(repo.lastSyncedAt)}>
          Synced {relativeTime(repo.lastSyncedAt)}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5">
        {repo.webUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={repo.webUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> <span className="hidden md:inline">Open on {REPO_PROVIDER_LABELS[repo.provider]}</span>
            </a>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History /> <span className="hidden md:inline">History</span>
        </Button>
        {canManage ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/projects/${encodeURIComponent(project.key)}/settings/repository`}>
              <Settings2 /> <span className="hidden md:inline">Settings</span>
            </Link>
          </Button>
        ) : null}
        {canSync ? (
          <Button size="sm" variant="outline" onClick={() => void sync()} disabled={requesting || syncing}>
            {requesting || syncing ? <Spinner /> : <RefreshCw />} Sync
          </Button>
        ) : null}
      </div>
      <SyncHistory projectKey={project.key} open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  )
}
