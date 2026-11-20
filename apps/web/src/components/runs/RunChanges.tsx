'use client'

// What the run changed, against the commit it started from (committed and uncommitted work, plus new files): every
// file with its status and line counts — narrowed to one step's files if you like — the diff, and the commits made
// during the run. Files matching the diff-exclude list (secrets) are listed but their content never left VS Code.

import { useMemo, useState } from 'react'
import { EyeOff, FileCode2, GitCommitHorizontal, Lock } from 'lucide-react'
import type { ChangedFile, ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import DiffView from '@/components/work/DiffView'
import { useRunDiff } from '@/hooks/runs/useRunRecords'
import { lineDelta, plural } from './runFormat'

const ALL = 'all'

const STATUS: Record<string, { label: string; className: string }> = {
  added: { label: 'A', className: 'text-success' },
  untracked: { label: 'A', className: 'text-success' },
  modified: { label: 'M', className: 'text-primary' },
  deleted: { label: 'D', className: 'text-destructive' },
  renamed: { label: 'R', className: 'text-muted-foreground' },
  copied: { label: 'C', className: 'text-muted-foreground' },
  type_changed: { label: 'T', className: 'text-muted-foreground' },
  unknown: { label: '?', className: 'text-muted-foreground' },
}

function FileRow({ file }: { file: ChangedFile }) {
  const s = STATUS[file.status] ?? STATUS.unknown
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-sm">
      <span className={UI.cn('font-mono text-xs font-semibold', s.className)} title={file.status}>
        {s.label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
        <span className="truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}
          {file.path}
        </span>
        {file.excluded ? (
          <span title="Matches the diff-exclude list: its content was not shared">
            <Lock className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
        ) : null}
      </span>
      <span className="text-xs whitespace-nowrap tabular-nums">
        {file.binary ? (
          <span className="text-muted-foreground">binary</span>
        ) : (
          <>
            <span className="text-success">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
          </>
        )}
      </span>
    </li>
  )
}

export default function RunChanges({ projectKey, run }: { projectKey: string; run: ProjectRunDetail }) {
  const [step, setStep] = useState<string>(ALL)
  const [showDiff, setShowDiff] = useState(false)
  const changes = run.changes
  const diff = useRunDiff(projectKey, run.id, showDiff, changes?.updatedAt)

  const stepsWithFiles = run.steps.filter((s) => s.changedFiles.length > 0)
  const files: ChangedFile[] = useMemo(() => {
    const all =
      changes?.files ?? run.changedFiles.map((path) => ({ path, status: 'modified' as const, additions: 0, deletions: 0, binary: false, excluded: false }))
    if (step === ALL) return all
    const only = new Set(run.steps.find((s) => s.stepId === step)?.changedFiles ?? [])
    return all.filter((f) => only.has(f.path))
  }, [changes, run.changedFiles, run.steps, step])

  if (!changes && run.changedFiles.length === 0) {
    return (
      <UI.EmptyState
        icon={<FileCode2 />}
        title="No changes reported"
        description="VS Code reports what a run changed as each step finishes and when the run ends. Runs started before this was recorded only list their files."
      />
    )
  }

  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)

  return (
    <div className="flex flex-col gap-4">
      <UI.Card className="gap-0 overflow-hidden py-0">
        <UI.CardHeader className="border-b py-3">
          <UI.CardTitle className="text-base">Files</UI.CardTitle>
          <UI.CardDescription>
            {plural(files.length, 'file')}
            {changes ? ` · ${lineDelta(additions, deletions)}` : ''}
            {changes?.baseSha ? (
              <>
                {' '}
                · against <span className="font-mono">{changes.baseSha.slice(0, 8)}</span>
                {changes.headSha && changes.headSha !== changes.baseSha ? (
                  <>
                    {' '}
                    → <span className="font-mono">{changes.headSha.slice(0, 8)}</span>
                  </>
                ) : null}
              </>
            ) : null}
            {changes ? ` · reported ${UI.relativeTime(changes.updatedAt)}` : ''}
          </UI.CardDescription>
          {stepsWithFiles.length > 0 ? (
            <UI.CardAction>
              <UI.Select value={step} onValueChange={setStep}>
                <UI.SelectTrigger className="w-48" size="sm" aria-label="Files of one step">
                  <UI.SelectValue />
                </UI.SelectTrigger>
                <UI.SelectContent>
                  <UI.SelectItem value={ALL}>Every step</UI.SelectItem>
                  {stepsWithFiles.map((s) => (
                    <UI.SelectItem key={s.stepId} value={s.stepId}>
                      {s.label} ({s.changedFiles.length})
                    </UI.SelectItem>
                  ))}
                </UI.SelectContent>
              </UI.Select>
            </UI.CardAction>
          ) : null}
        </UI.CardHeader>
        <ul className="max-h-[28rem] divide-y overflow-y-auto">
          {files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
          {files.length === 0 ? <li className="px-3 py-4 text-sm text-muted-foreground">This step didn’t change any files.</li> : null}
        </ul>
      </UI.Card>

      {changes ? (
        <UI.Card className="gap-3">
          <UI.CardHeader>
            <UI.CardTitle className="text-base">Diff</UI.CardTitle>
            <UI.CardDescription>
              {changes.hasPatch
                ? `Every change since the run started${changes.patchTruncated ? ' (cut short — it was very large)' : ''}`
                : 'Diff sharing is off in this developer’s VS Code, so only the file list was reported.'}
            </UI.CardDescription>
            {changes.hasPatch ? (
              <UI.CardAction>
                <UI.Button variant="outline" size="sm" onClick={() => setShowDiff(!showDiff)}>
                  {showDiff ? (
                    <>
                      <EyeOff /> Hide
                    </>
                  ) : (
                    'Show diff'
                  )}
                </UI.Button>
              </UI.CardAction>
            ) : null}
          </UI.CardHeader>
          {showDiff ? (
            <UI.CardContent>
              {diff.error ? <UI.ErrorAlert message={diff.error.message} /> : null}
              {diff.loading && !diff.data ? <UI.Skeleton className="h-48 rounded-lg" /> : null}
              {diff.data?.patch ? <DiffView patch={diff.data.patch} truncated={diff.data.patchTruncated} /> : null}
              {diff.data && !diff.data.patch ? <p className="text-sm text-muted-foreground">No textual changes.</p> : null}
            </UI.CardContent>
          ) : null}
        </UI.Card>
      ) : null}

      {changes?.commits.length ? (
        <UI.Card className="gap-3">
          <UI.CardHeader>
            <UI.CardTitle className="text-base">Commits during the run</UI.CardTitle>
            <UI.CardDescription>{plural(changes.commits.length, 'commit')} on {changes.branch ?? 'the branch'}</UI.CardDescription>
          </UI.CardHeader>
          <UI.CardContent>
            <ul className="flex flex-col divide-y">
              {changes.commits.map((c) => (
                <li key={c.sha} className="flex items-start gap-3 py-2 text-sm">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{c.message.split('\n')[0]}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono">{c.sha.slice(0, 8)}</span>
                      {c.committedAt ? ` · ${UI.relativeTime(c.committedAt)}` : ''} · {plural(c.files, 'file')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </UI.CardContent>
        </UI.Card>
      ) : null}
    </div>
  )
}
