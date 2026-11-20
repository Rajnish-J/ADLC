'use client'

// A project's linked repository: link one, change its URL or default branch, see how the platform reaches it
// (which Git connection), sync, see recent syncs, or disconnect. Owners and org admins change it; developers can sync.
// A workspace (blank project) has no remote: it can be published to GitHub or deleted.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CircleCheck, KeyRound, RefreshCw, Trash2, Unplug, UploadCloud } from 'lucide-react'
import { REPO_PROVIDER_LABELS, type ProjectDetail, type ProjectRepository } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as K from '@/imports/code.imports'

function Access({ project, repo, busy, onUseConnections }: { project: ProjectDetail; repo: ProjectRepository; busy: boolean; onUseConnections: () => void }) {
  const isAdmin = project.permissions.includes('org.manage')
  const c = repo.credential
  let text: React.ReactNode
  if (c.source === 'connection') {
    text = (
      <>
        Through the Git connection <span className="font-medium text-foreground">{c.connectionName}</span>.
      </>
    )
  } else if (c.source === 'project') {
    text = (
      <>
        Through a token stored on this project ({repo.tokenHint ?? '…'}) from before Git connections existed.{' '}
        {project.permissions.includes('repo.manage') ? (
          <UI.Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onUseConnections} disabled={busy}>
            Use the Git connections instead
          </UI.Button>
        ) : null}
      </>
    )
  } else if (repo.provider === 'local') {
    text = 'A local test repository — no access needed.'
  } else {
    text = 'Without a token: no Git connection covers this repository, so only a public one can be read, and commits will fail.'
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Access · </span>
        {text}
        {isAdmin && repo.provider !== 'local' ? (
          <>
            {' '}
            <Link href="/settings/git-connections" className="text-primary hover:underline">
              Manage Git connections
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}

function RecentSyncs({ projectKey }: { projectKey: string }) {
  const { data } = K.useSyncs(projectKey, true)
  const recent = (data ?? []).slice(0, 5)
  if (recent.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Recent syncs</p>
      <ul className="flex flex-col divide-y rounded-lg border text-sm">
        {recent.map((s) => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-2">
            {s.status === 'succeeded' ? (
              <CircleCheck className="size-4 shrink-0 text-success" />
            ) : s.status === 'failed' ? (
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
            ) : (
              <UI.Spinner className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {s.branch ? <span className="font-mono text-xs">{s.branch}</span> : 'Full sync'}
              {s.error ? <span className="text-destructive"> — {s.error}</span> : null}
              {s.stats?.catalog ? (
                <span className="text-muted-foreground">
                  {' '}
                  · {s.stats.catalog.agents} agents, {s.stats.catalog.skills} skills
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{UI.relativeTime(s.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function WorkspaceSettings({ project, repo }: { project: ProjectDetail; repo: ProjectRepository }) {
  const canManage = project.permissions.includes('repo.manage')
  const [publishing, setPublishing] = useState(false)
  const [busy, setBusy] = useState(false)

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await K.disconnectRepository(project.key)
      UI.toast.success('Workspace deleted')
    } catch (err) {
      UI.toast.error(err instanceof K.AppError ? err.message : 'Could not delete the workspace.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <K.ProviderIcon provider={repo.provider} className="text-muted-foreground" />
        <span className="font-medium">{repo.displayName}</span>
        <UI.Badge variant="outline">Workspace</UI.Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        The project’s files are kept on the platform. Publish them to a new GitHub repository to sync and commit there from now on.
      </p>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <UI.Button onClick={() => setPublishing(true)} disabled={busy}>
            <UploadCloud /> Publish to GitHub
          </UI.Button>
          <UI.AlertDialog>
            <UI.AlertDialogTrigger asChild>
              <UI.Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy}>
                <Trash2 /> Delete workspace
              </UI.Button>
            </UI.AlertDialogTrigger>
            <UI.AlertDialogContent>
              <UI.AlertDialogHeader>
                <UI.AlertDialogTitle>Delete the workspace?</UI.AlertDialogTitle>
                <UI.AlertDialogDescription>
                  Every file in it and every uncommitted draft is removed for good. The project itself stays, and you can link a repository afterwards.
                </UI.AlertDialogDescription>
              </UI.AlertDialogHeader>
              <UI.AlertDialogFooter>
                <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
                <UI.AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  Delete workspace
                </UI.AlertDialogAction>
              </UI.AlertDialogFooter>
            </UI.AlertDialogContent>
          </UI.AlertDialog>
        </div>
      ) : null}
      <K.PublishWorkspaceDialog project={project} open={publishing} onOpenChange={setPublishing} />
    </>
  )
}

export default function RepositoryCard({ project }: { project: ProjectDetail }) {
  const { data: repo, loading } = K.useRepository(project.key)
  const canManage = project.permissions.includes('repo.manage')
  const canSync = project.permissions.includes('code.edit')
  const [values, setValues] = useState<K.RepositoryValues>(K.EMPTY_REPOSITORY)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValues(repo ? { url: repo.remoteUrl, defaultBranch: repo.defaultBranch ?? '' } : K.EMPTY_REPOSITORY)
    setError(null)
  }, [repo?.remoteUrl, repo?.defaultBranch, repo])

  async function run(action: () => Promise<object | void | null>, success: string, failure: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      UI.toast.success(success)
    } catch (err) {
      setError(err instanceof K.AppError ? err.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const save = (dropProjectToken = false) =>
    run(
      () => K.saveRepository(project.key, { url: values.url.trim(), defaultBranch: values.defaultBranch.trim() || null, ...(dropProjectToken ? { token: null } : {}) }),
      repo ? 'Repository settings saved — a sync has started' : 'Repository linked — cloning it now',
      'Could not save the repository.',
    )

  const dirty = repo ? values.url.trim() !== repo.remoteUrl || values.defaultBranch.trim() !== (repo.defaultBranch ?? '') : values.url.trim() !== ''

  return (
    <UI.Card id="repository">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Repository</UI.CardTitle>
        <UI.CardDescription>
          The GitHub or Azure Repos repository behind the Code page and the repo’s agents and skills.
          {repo ? (
            <>
              {' '}
              <Link href={`/projects/${project.key}/code`} className="text-primary hover:underline">
                Open the Code page
              </Link>
            </>
          ) : null}
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-5">
        {loading ? (
          <UI.Skeleton className="h-32" />
        ) : repo?.provider === 'workspace' ? (
          <WorkspaceSettings project={project} repo={repo} />
        ) : (
          <>
            {repo ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <K.ProviderIcon provider={repo.provider} className="text-muted-foreground" />
                <span className="font-mono text-xs">{repo.displayName}</span>
                <UI.Badge variant="outline">{REPO_PROVIDER_LABELS[repo.provider]}</UI.Badge>
                {repo.activeSync ? (
                  <UI.Badge variant="secondary">
                    <UI.Spinner className="size-3" /> Syncing
                  </UI.Badge>
                ) : repo.status === 'failed' ? (
                  <UI.Badge variant="destructive" title={repo.lastError ?? undefined}>
                    <AlertTriangle /> Last sync failed
                  </UI.Badge>
                ) : repo.lastSyncedAt ? (
                  <span className="text-xs text-muted-foreground">Synced {UI.relativeTime(repo.lastSyncedAt)}</span>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No repository is linked.{canManage ? ' Link one to browse and edit the code here.' : ' Owners can link one.'}</p>
            )}
            {repo?.status === 'failed' && repo.lastError ? <p className="text-sm text-destructive">{repo.lastError}</p> : null}

            {canManage ? (
              <K.RepositoryFields id={`settings-repo-${project.key}`} value={values} onChange={setValues} onTest={(input) => K.testProjectRepository(project.key, input)} disabled={busy} />
            ) : null}
            {repo ? <Access project={project} repo={repo} busy={busy} onUseConnections={() => void save(true)} /> : null}
            {error ? <UI.FieldError>{error}</UI.FieldError> : null}

            <div className="flex flex-wrap items-center gap-2">
              {canManage ? (
                <UI.Button onClick={() => void save()} disabled={busy || !dirty || !values.url.trim()}>
                  {busy ? <UI.Spinner /> : null} {repo ? 'Save and sync' : 'Link and clone'}
                </UI.Button>
              ) : null}
              {repo && canSync ? (
                <UI.Button variant="outline" onClick={() => void run(() => K.syncRepository(project.key), 'Sync started', 'Could not start a sync.')} disabled={busy || repo.activeSync !== null}>
                  <RefreshCw /> Sync now
                </UI.Button>
              ) : null}
              {repo && canManage ? (
                <UI.AlertDialog>
                  <UI.AlertDialogTrigger asChild>
                    <UI.Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy}>
                      <Unplug /> Disconnect
                    </UI.Button>
                  </UI.AlertDialogTrigger>
                  <UI.AlertDialogContent>
                    <UI.AlertDialogHeader>
                      <UI.AlertDialogTitle>Disconnect {repo.displayName}?</UI.AlertDialogTitle>
                      <UI.AlertDialogDescription>
                        The repository itself is not touched. The platform’s copy of its files, all uncommitted drafts and the agents and skills imported from
                        it are removed from {project.key} (except any a workflow still uses).
                      </UI.AlertDialogDescription>
                    </UI.AlertDialogHeader>
                    <UI.AlertDialogFooter>
                      <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
                      <UI.AlertDialogAction
                        variant="destructive"
                        onClick={() => void run(() => K.disconnectRepository(project.key), `Disconnected ${repo.displayName}`, 'Could not disconnect the repository.')}
                      >
                        Disconnect
                      </UI.AlertDialogAction>
                    </UI.AlertDialogFooter>
                  </UI.AlertDialogContent>
                </UI.AlertDialog>
              ) : null}
            </div>
            {repo ? <RecentSyncs projectKey={project.key} /> : null}
          </>
        )}
      </UI.CardContent>
    </UI.Card>
  )
}
