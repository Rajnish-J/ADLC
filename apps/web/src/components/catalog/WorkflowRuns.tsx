'use client'

// Workflow › Runs: every agent run in the project — each story or task started in VS Code, and each quick fix — by
// every developer, reported live. Filter by status, kind, workflow, harness, who started it, or a file the run
// changed; export the table as CSV. A row opens the run's own page (what it changed, the memory it used, its impact).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, FileSearch, PlayCircle, X } from 'lucide-react'
import { harnessLabel, RUN_KINDS, RUN_KIND_LABELS, RUN_STATUSES, RUN_STATUS_LABELS, type ProjectDetail, type RunKind, type StoryRunStatus } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { useSession } from '@/components/providers/SessionProvider'
import { runHref } from '@/components/work/RunComposerProvider'
import { useRunList } from '@/hooks/runs/useRunRecords'
import { downloadText, runsCsv } from '@/lib/runReport'
import { runColumns } from './run-columns'

const ALL = 'all'
const ME = 'me'

interface WorkflowRunsProps {
  project: ProjectDetail
  /** Who started the runs (a user id), shared with the dashboard; undefined = everyone. */
  user?: string
  onUserChange: (user: string | undefined) => void
  /** Runs that changed a file whose path contains this text. */
  file: string
  onFileChange: (file: string) => void
}

export default function WorkflowRuns({ project, user, onUserChange, file, onFileChange }: WorkflowRunsProps) {
  const router = useRouter()
  const { me } = useSession()
  const [kind, setKind] = useState<RunKind | typeof ALL>(ALL)
  const [status, setStatus] = useState<StoryRunStatus | typeof ALL>(ALL)
  const [workflow, setWorkflow] = useState<string>(ALL)
  const [harness, setHarness] = useState<string>(ALL)
  const [fileText, setFileText] = useState(file)
  useEffect(() => setFileText(file), [file])
  // The file filter runs on the server; wait for typing to settle.
  useEffect(() => {
    const t = setTimeout(() => fileText !== file && onFileChange(fileText.trim()), 400)
    return () => clearTimeout(t)
  }, [fileText, file, onFileChange])

  const { data: runs, error, loading } = useRunList(project.key, { kind: kind === ALL ? undefined : kind, user, file: file || undefined })

  const filtered = Boolean(user || file || kind !== ALL)
  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading && !runs) return <UI.Skeleton className="h-96 rounded-xl" />
  if (runs && runs.length === 0 && !filtered) {
    return (
      <UI.EmptyState
        icon={<PlayCircle />}
        title="No runs yet"
        description="Describe a quick fix above, or pick a story with #, and run it in your VS Code harness. Every run — its changes, the memory it used and its evaluations — appears here live."
      />
    )
  }

  const all = runs ?? []
  const workflows = [...new Set(all.map((r) => r.workflowName))].sort()
  const harnesses = [...new Set(all.map((r) => r.engine ?? 'built-in'))].sort()
  const shown = all.filter(
    (r) =>
      (status === ALL || r.status === status) &&
      (workflow === ALL || r.workflowName === workflow) &&
      (harness === ALL || (r.engine ?? 'built-in') === harness),
  )
  const whoValue = !user ? ALL : user === me?.user.id ? ME : user
  const others = project.members.filter((m) => m.user.id !== me?.user.id)

  return (
    <UI.DataTable
      columns={runColumns}
      data={shown}
      searchColumn="workflow"
      searchPlaceholder="Search runs, stories or prompts…"
      pageSize={20}
      initialSorting={[{ id: 'started', desc: true }]}
      onRowClick={(r) => router.push(runHref(project.key, r.id))}
      emptyMessage="No runs match these filters."
      toolbar={
        <>
          <UI.Select value={kind} onValueChange={(v) => setKind(v as RunKind | typeof ALL)}>
            <UI.SelectTrigger className="w-36" aria-label="Kind">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              <UI.SelectItem value={ALL}>All kinds</UI.SelectItem>
              {RUN_KINDS.map((k) => (
                <UI.SelectItem key={k} value={k}>
                  {RUN_KIND_LABELS[k]}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
          <UI.Select value={status} onValueChange={(v) => setStatus(v as StoryRunStatus | typeof ALL)}>
            <UI.SelectTrigger className="w-40" aria-label="Status">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              <UI.SelectItem value={ALL}>All statuses</UI.SelectItem>
              {RUN_STATUSES.map((s) => (
                <UI.SelectItem key={s} value={s}>
                  {RUN_STATUS_LABELS[s]}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
          <UI.Select value={whoValue} onValueChange={(v) => onUserChange(v === ALL ? undefined : v === ME ? me?.user.id : v)}>
            <UI.SelectTrigger className="w-40" aria-label="Started by">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              <UI.SelectItem value={ALL}>Everyone</UI.SelectItem>
              {me ? <UI.SelectItem value={ME}>My runs</UI.SelectItem> : null}
              {others.map((m) => (
                <UI.SelectItem key={m.user.id} value={m.user.id}>
                  {m.user.displayName}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
          {workflows.length > 1 ? (
            <UI.Select value={workflow} onValueChange={setWorkflow}>
              <UI.SelectTrigger className="w-44" aria-label="Workflow">
                <UI.SelectValue />
              </UI.SelectTrigger>
              <UI.SelectContent>
                <UI.SelectItem value={ALL}>All workflows</UI.SelectItem>
                {workflows.map((w) => (
                  <UI.SelectItem key={w} value={w}>
                    {w}
                  </UI.SelectItem>
                ))}
              </UI.SelectContent>
            </UI.Select>
          ) : null}
          {harnesses.length > 1 ? (
            <UI.Select value={harness} onValueChange={setHarness}>
              <UI.SelectTrigger className="w-40" aria-label="Harness">
                <UI.SelectValue />
              </UI.SelectTrigger>
              <UI.SelectContent>
                <UI.SelectItem value={ALL}>All harnesses</UI.SelectItem>
                {harnesses.map((h) => (
                  <UI.SelectItem key={h} value={h}>
                    {h === 'built-in' ? 'Built-in runtime' : harnessLabel(h)}
                  </UI.SelectItem>
                ))}
              </UI.SelectContent>
            </UI.Select>
          ) : null}
          <UI.InputGroup className="w-56">
            <UI.InputGroupAddon>
              <FileSearch />
            </UI.InputGroupAddon>
            <UI.InputGroupInput value={fileText} onChange={(e) => setFileText(e.target.value)} placeholder="Changed file…" aria-label="Runs that changed a file" />
            {fileText ? (
              <UI.InputGroupAddon align="inline-end">
                <UI.InputGroupButton size="icon-xs" aria-label="Clear the file filter" onClick={() => onFileChange('')}>
                  <X />
                </UI.InputGroupButton>
              </UI.InputGroupAddon>
            ) : null}
          </UI.InputGroup>
          <UI.Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={shown.length === 0}
            onClick={() => downloadText(`${project.key}-runs.csv`, runsCsv(shown), 'text/csv')}
          >
            <Download /> CSV
          </UI.Button>
        </>
      }
    />
  )
}
