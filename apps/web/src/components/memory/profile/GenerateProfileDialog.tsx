'use client'

// "Generate from repository": pick a branch of the linked repository and the built-in Project profiler writes the
// project profile from its files (in the background — the card on the Memory page follows along). A branch nobody
// opened yet is loaded first, then the profile is generated as soon as its files are in.

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { FileSearch, Sparkles, TriangleAlert } from 'lucide-react'
import { AppError } from '@/appError'
import BranchSwitcher from '@/components/code/BranchSwitcher'
import ProviderIcon from '@/components/code/ProviderIcon'
import { useBranches, useRepository } from '@/hooks/code/useCode'
import * as UI from '@/imports/UI.imports'
import { openBranch } from '@/service/code.service'
import { generateProjectProfile } from '@/service/profile.service'

interface Props {
  projectKey: string
  aiEnabled: boolean
  aiReason: string | null
  /** Regenerating replaces the accepted profile (and any update waiting for review). */
  regenerate?: boolean
  trigger: ReactNode
}

const READS = ['README and docs (CLAUDE.md, AGENTS.md, docs/)', 'Manifests: package.json, pyproject, go.mod, Dockerfiles…', 'CI pipelines and example env files (names only)', 'Folder layout, languages and tests — counted', 'Stories and recent runs on the platform']

export default function GenerateProfileDialog({ projectKey, aiEnabled, aiReason, regenerate, trigger }: Props) {
  const [open, setOpen] = useState(false)
  const repo = useRepository(projectKey)
  const hasRepo = Boolean(repo.data)
  const branches = useBranches(projectKey, open && hasRepo)
  const [picked, setPicked] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const list = branches.data ?? []
  const current = picked ?? repo.data?.defaultBranch ?? list.find((b) => b.isDefault)?.name ?? list[0]?.name ?? ''
  const branch = list.find((b) => b.name === current)

  async function start(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await generateProjectProfile(projectKey, { branch: current || undefined })
      UI.toast.success('The Project profiler is reading the repository', { description: 'The profile appears on this page in a minute or two.' })
      setOpen(false)
      setWaiting(false)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not start the profiler.')
      setWaiting(false)
    } finally {
      setSaving(false)
    }
  }

  async function submit(): Promise<void> {
    if (branch && !branch.indexedSha) {
      // Load the branch's files first; the effect below starts the profiler once they are in.
      setWaiting(true)
      setError(null)
      try {
        if (!branch.indexing) await openBranch(projectKey, branch.name)
      } catch (err) {
        setWaiting(false)
        setError(err instanceof AppError ? err.message : 'Could not open the branch.')
      }
      return
    }
    await start()
  }

  useEffect(() => {
    if (waiting && branch?.indexedSha && !saving) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, branch?.indexedSha])

  return (
    <UI.Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) {
          setError(null)
          setWaiting(false)
          setPicked(null)
        }
      }}
    >
      <UI.DialogTrigger asChild>{trigger}</UI.DialogTrigger>
      <UI.DialogContent className="sm:max-w-lg">
        <UI.DialogHeader>
          <UI.DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> {regenerate ? 'Regenerate the project profile' : 'Generate the project profile'}
          </UI.DialogTitle>
          <UI.DialogDescription>
            The built-in <span className="font-medium text-foreground">Project profiler</span> reads the linked repository and writes what the project is, its tech stack, architecture, status,
            developer guide and integrations. Every agent run gets the profile as context.
          </UI.DialogDescription>
        </UI.DialogHeader>

        {repo.loading && !repo.data ? (
          <UI.Skeleton className="h-24 rounded-lg" />
        ) : !repo.data ? (
          <UI.Alert>
            <TriangleAlert />
            <UI.AlertTitle>No repository linked</UI.AlertTitle>
            <UI.AlertDescription>
              Link the project’s repository first in{' '}
              <Link href={`/projects/${projectKey}/settings`} className="font-medium text-primary hover:underline">
                Settings → Repository
              </Link>
              .
            </UI.AlertDescription>
          </UI.Alert>
        ) : (
          <UI.FieldGroup>
            <UI.Field>
              <UI.FieldLabel>Repository</UI.FieldLabel>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <ProviderIcon provider={repo.data.provider} className="size-4" />
                <span className="truncate font-medium">{repo.data.displayName}</span>
                {repo.data.status !== 'ready' ? <UI.Badge variant="outline">{repo.data.status}</UI.Badge> : null}
              </div>
            </UI.Field>
            <UI.Field>
              <UI.FieldLabel>Branch</UI.FieldLabel>
              {branches.loading && !branches.data ? (
                <UI.Skeleton className="h-9 w-48" />
              ) : list.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  <BranchSwitcher branches={list} current={current} canCreate={false} onSelect={(b) => setPicked(b)} onCreate={async () => undefined} />
                  {branch?.commit ? <span className="truncate text-xs text-muted-foreground">{branch.commit.message.split('\n')[0]}</span> : null}
                </div>
              ) : (
                <UI.FieldDescription>The repository has no branches yet.</UI.FieldDescription>
              )}
              <UI.FieldDescription>
                {branch && !branch.indexedSha ? 'This branch hasn’t been opened yet — its files are loaded first.' : `${branch?.fileCount ?? 0} files indexed on this branch.`}
              </UI.FieldDescription>
            </UI.Field>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                <FileSearch className="size-3.5" /> What it reads
              </p>
              <ul className="ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">
                {READS.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            {!aiEnabled ? (
              <UI.Alert>
                <TriangleAlert />
                <UI.AlertTitle>AI model not configured</UI.AlertTitle>
                <UI.AlertDescription>{aiReason ?? 'No AI model is configured.'} The profile will hold only what can be counted from the repository.</UI.AlertDescription>
              </UI.Alert>
            ) : null}
            {regenerate ? <UI.FieldDescription>The new profile replaces the current one; earlier versions stay in History.</UI.FieldDescription> : null}
            {error ? <UI.FieldError>{error}</UI.FieldError> : null}
          </UI.FieldGroup>
        )}

        <UI.DialogFooter>
          <UI.Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </UI.Button>
          <UI.Button onClick={() => void submit()} disabled={!repo.data || !current || saving || waiting}>
            {saving || waiting ? <UI.Spinner /> : <Sparkles />} {waiting ? 'Loading branch…' : regenerate ? 'Regenerate' : 'Generate profile'}
          </UI.Button>
        </UI.DialogFooter>
      </UI.DialogContent>
    </UI.Dialog>
  )
}
