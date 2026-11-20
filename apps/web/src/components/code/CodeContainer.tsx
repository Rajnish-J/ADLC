'use client'

// The project's code, cloned from its GitHub / Azure Repos repository: connect one (owners), watch the first
// clone, then browse, edit and commit in the workbench. Everything refreshes live as syncs and commits land.

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { FolderGit2, RefreshCw } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as K from '@/imports/code.imports'
import RunBranchWorkbench from './RunBranchWorkbench'

/** No repository yet: owners link one in Settings → Project settings → Repository. */
function NoRepository({ project }: { project: K.ProjectDetail }) {
  const canManage = project.permissions.includes('repo.manage')
  return (
    <UI.EmptyState
      icon={<FolderGit2 />}
      title="No repository linked"
      description={
        canManage
          ? 'Link the project’s GitHub or Azure Repos repository to browse and edit its code here and pick up the agents and skills it defines.'
          : 'A project owner can link the project’s GitHub or Azure Repos repository to browse and edit its code here.'
      }
    >
      {canManage ? (
        <UI.Button asChild>
          <Link href={`/projects/${encodeURIComponent(project.key)}/settings/repository`}>
            <FolderGit2 /> Link a repository
          </Link>
        </UI.Button>
      ) : null}
    </UI.EmptyState>
  )
}

function Code({ project }: { project: K.ProjectDetail }) {
  const { data: repo, error, loading } = K.useRepository(project.key)
  const { data: branches } = K.useBranches(project.key, Boolean(repo))
  const [retrying, setRetrying] = useState(false)
  // ?run=<id>: a workflow run's branch, as VS Code reported it (it is never pushed).
  const runId = useSearchParams().get('run')

  if (error) return <UI.ErrorAlert title="Could not load the repository" message={error.message} />
  if (loading) return <UI.Skeleton className="h-[520px] rounded-xl" />
  if (runId && /^[0-9a-f-]{36}$/i.test(runId)) {
    return (
      <>
        {repo ? <K.RepositoryBar project={project} repo={repo} /> : null}
        <RunBranchWorkbench project={project} repo={repo} runId={runId} />
      </>
    )
  }
  if (!repo) return <NoRepository project={project} />

  const defaultIndexed = branches?.some((b) => b.isDefault && b.indexedSha)

  async function retry(): Promise<void> {
    setRetrying(true)
    try {
      await K.syncRepository(project.key)
    } catch (err) {
      UI.toast.error(err instanceof K.AppError ? err.message : 'Could not start a sync.')
    } finally {
      setRetrying(false)
    }
  }

  let body: React.ReactNode
  if (!defaultIndexed && repo.status === 'failed') {
    body = (
      <UI.Alert variant="destructive">
        <UI.AlertTitle>The repository could not be cloned</UI.AlertTitle>
        <UI.AlertDescription>
          <p>{repo.lastError ?? 'The last sync failed.'}</p>
          {repo.credential.source === 'none' && repo.provider !== 'local' ? (
            <p className="mt-1">
              No Git connection covers this repository.{' '}
              {project.permissions.includes('org.manage') ? (
                <Link href="/settings/git-connections" className="font-medium underline">
                  Add one in Settings → Git connections
                </Link>
              ) : (
                'Ask an org admin to add one in Settings → Git connections'
              )}{' '}
              — the clone is retried automatically when it is added.
            </p>
          ) : null}
          {project.permissions.includes('code.edit') ? (
            <UI.Button size="sm" variant="outline" className="mt-2" onClick={() => void retry()} disabled={retrying || repo.activeSync !== null}>
              {retrying || repo.activeSync ? <UI.Spinner /> : <RefreshCw />} Try again
            </UI.Button>
          ) : null}
        </UI.AlertDescription>
      </UI.Alert>
    )
  } else if (!defaultIndexed && (repo.status === 'queued' || repo.status === 'syncing' || repo.activeSync)) {
    body = (
      <UI.Card>
        <UI.CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <UI.Spinner className="size-8 text-primary" />
          <p className="font-medium">Cloning {repo.displayName}…</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Fetching the default branch, leaving out what .gitignore excludes, storing the text files and importing agents and skills. This page updates on
            its own.
          </p>
        </UI.CardContent>
      </UI.Card>
    )
  } else if (!branches || branches.length === 0) {
    body = <UI.EmptyState icon={<FolderGit2 />} title="The repository is empty" description="Push a first commit, then Sync." />
  } else {
    body = <K.CodeWorkbench project={project} repo={repo} branches={branches} />
  }

  return (
    <>
      <K.RepositoryBar project={project} repo={repo} />
      {defaultIndexed && repo.status === 'failed' && repo.lastError ? (
        <UI.Alert variant="destructive">
          <UI.AlertTitle>The last sync failed — showing the code from the previous one</UI.AlertTitle>
          <UI.AlertDescription>{repo.lastError}</UI.AlertDescription>
        </UI.Alert>
      ) : null}
      {body}
    </>
  )
}

export default function CodeContainer() {
  return (
    <K.ProjectShell title="Code" description="The project’s repository — browse it, edit a file, and commit to any branch.">
      {(project) => (
        <Suspense fallback={<UI.Skeleton className="h-[520px] rounded-xl" />}>
          <Code project={project} />
        </Suspense>
      )}
    </K.ProjectShell>
  )
}
