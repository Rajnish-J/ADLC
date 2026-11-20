// "Code & runs": who is working on the story right now (uncommitted changes), the commits on its branch, and the
// agent runs started on it — each expandable to files, diff, or steps.

import { useState } from 'react'
import type { ChangedFile, EvaluationResult, StoryCommit, StoryRun, StoryWork, WorkspaceSnapshot } from '@sdlc/contracts'
import { diffKey, type DiffRef, type PanelTracking } from '../../platform/storyPanel/storyPanelMessages'
import { cx, duration, exactTime, relativeTime, RUN_LABEL, send } from './api'
import { DiffView } from './DiffView'

export interface DiffState {
  loading: boolean
  patch?: string | null
  truncated?: boolean
  error?: string
}

interface Props {
  work: StoryWork | null
  tracking: PanelTracking
  diffs: Record<string, DiffState>
  onLoadDiff: (ref: DiffRef) => void
}

const LIVE_MS = 2 * 60_000

function FileList({ files }: { files: ChangedFile[] }) {
  return (
    <ul className="files">
      {files.map((f) => (
        <li key={f.path}>
          <button type="button" className="link mono" onClick={() => send({ type: 'openFile', path: f.path })} title="Open in the editor">
            {f.path}
          </button>
          <span className="tag">{f.status}</span>
          {f.excluded ? <span className="tag warn" title="Matches the diff-exclude patterns: content was never sent">content not shared</span> : null}
          {f.binary ? <span className="tag">binary</span> : <span className="counts"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>}
        </li>
      ))}
    </ul>
  )
}

function DiffToggle({ diffRef, has, diffs, onLoadDiff }: { diffRef: DiffRef; has: boolean; diffs: Props['diffs']; onLoadDiff: Props['onLoadDiff'] }) {
  const [open, setOpen] = useState(false)
  if (!has) return null
  const state = diffs[diffKey(diffRef)]
  return (
    <div>
      <button
        type="button"
        className="btn secondary small"
        onClick={() => {
          if (!open && !state) onLoadDiff(diffRef)
          setOpen(!open)
        }}
      >
        {open ? 'Hide diff' : 'View diff'}
      </button>
      {open ? (
        state?.loading || !state ? (
          <p className="muted">Loading diff…</p>
        ) : state.error ? (
          <p className="error">{state.error}</p>
        ) : state.patch ? (
          <DiffView patch={state.patch} truncated={state.truncated} />
        ) : (
          <p className="muted">No diff was shared.</p>
        )
      ) : null}
    </div>
  )
}

function Workspace({ w, diffs, onLoadDiff }: { w: WorkspaceSnapshot; diffs: Props['diffs']; onLoadDiff: Props['onLoadDiff'] }) {
  const live = Date.now() - new Date(w.updatedAt).getTime() < LIVE_MS
  return (
    <div className="card">
      <div className="row">
        <span className={cx('dot', live ? 'live' : 'idle')} />
        <strong>{w.user.displayName}</strong>
        <span className="mono muted">{w.branch}</span>
        {w.ahead || w.behind ? <span className="tag">↑{w.ahead} ↓{w.behind}</span> : null}
        <span className="spacer" />
        <span className="muted" title={exactTime(w.updatedAt)}>{live ? 'working now' : `last seen ${relativeTime(w.updatedAt)}`}</span>
      </div>
      {w.files.length === 0 ? (
        <p className="muted">No uncommitted changes.</p>
      ) : (
        <>
          <p className="muted">
            {w.files.length} file{w.files.length === 1 ? '' : 's'} changed · <span className="add">+{w.additions}</span> <span className="del">−{w.deletions}</span>
          </p>
          <FileList files={w.files} />
          <DiffToggle diffRef={{ kind: 'workspace', userId: w.user.id }} has={w.hasPatch} diffs={diffs} onLoadDiff={onLoadDiff} />
        </>
      )}
    </div>
  )
}

function Commit({ c, diffs, onLoadDiff }: { c: StoryCommit; diffs: Props['diffs']; onLoadDiff: Props['onLoadDiff'] }) {
  const [open, setOpen] = useState(false)
  const [subject, ...body] = c.message.split('\n')
  return (
    <li className="commit">
      <button type="button" className="row clickable" onClick={() => setOpen(!open)}>
        <span className={cx('codicon-chevron', open && 'open')}>›</span>
        <span className="mono sha">{c.sha.slice(0, 7)}</span>
        <span className="grow ellipsis">{subject}</span>
        <span className="add">+{c.additions}</span>
        <span className="del">−{c.deletions}</span>
        <span className="muted" title={exactTime(c.committedAt)}>{c.authorName} · {relativeTime(c.committedAt)}</span>
      </button>
      {open ? (
        <div className="indent">
          {body.join('\n').trim() ? <pre className="message">{body.join('\n').trim()}</pre> : null}
          <FileList files={c.files} />
          <DiffToggle diffRef={{ kind: 'commit', sha: c.sha }} has={c.hasPatch} diffs={diffs} onLoadDiff={onLoadDiff} />
        </div>
      ) : null}
    </li>
  )
}

const STEP_ICON: Record<string, string> = { succeeded: '✓', failed: '✕', running: '●', skipped: '–', blocked: '⏸' }

// Kept here rather than imported, so the webview bundle carries no @sdlc/contracts runtime code.
const HARNESS_LABEL: Record<string, string> = { copilot: 'GitHub Copilot', 'claude-code': 'Claude Code', codex: 'Codex', 'roo-code': 'Roo Code', 'kilo-code': 'Kilo Code' }
const harnessLabel = (id: string) => HARNESS_LABEL[id] ?? id

const fmtScore = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2))

/** Every evaluator behind a gate: score against threshold, pass/fail, advisory, its reason and dataset counts. */
function Evaluations({ evaluations, reportUrl }: { evaluations: EvaluationResult[]; reportUrl: string | null }) {
  if (!evaluations.length) return null
  return (
    <table className="evals indent">
      <tbody>
        {evaluations.map((e) => (
          <tr key={e.evaluator}>
            <td>
              <span className="ellipsis">{e.evaluator}</span>
              {e.reason ? <div className="muted">{e.reason}</div> : null}
            </td>
            <td className="mono">
              {fmtScore(e.score)} / {fmtScore(e.threshold)}
            </td>
            <td>
              <span className={cx('tag', e.pass ? 'ok' : 'warn')}>{e.pass ? 'pass' : 'fail'}</span>
              {e.required === false ? <span className="tag">advisory</span> : null}
            </td>
            <td className="muted mono">{e.counts ? `${e.counts.passed}✓ ${e.counts.failed}✗` : ''}</td>
          </tr>
        ))}
        {reportUrl ? (
          <tr>
            <td colSpan={4}>
              <a href={reportUrl}>Full evaluation report</a>
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}

function Run({ run }: { run: StoryRun }) {
  const [open, setOpen] = useState(run.status === 'running' || run.status === 'awaiting_approval')
  return (
    <li className="run">
      <button type="button" className="row clickable" onClick={() => setOpen(!open)}>
        <span className={cx('codicon-chevron', open && 'open')}>›</span>
        <strong className="grow ellipsis">
          {run.workflowName}
          {run.task ? ` · ${run.task.key}` : ''}
        </strong>
        <span className="tag">{run.engine ? harnessLabel(run.engine) : 'built-in'}</span>
        <span className={cx('pill', `run-${run.status}`)}>{RUN_LABEL[run.status]}</span>
        <span className="muted">
          {run.startedBy?.displayName ?? 'Someone'} · {relativeTime(run.startedAt)} · {duration(run.startedAt, run.finishedAt)}
        </span>
      </button>
      {open ? (
        <div className="indent">
          {run.pendingApproval ? <p className="notice">Waiting for approval: {run.pendingApproval.question}</p> : null}
          {run.error ? <p className="error">{run.error}</p> : null}
          <p className="muted">
            {run.tokensIn + run.tokensOut > 0 ? `${(run.tokensIn + run.tokensOut).toLocaleString()} tokens · ` : ''}
            {run.changedFiles.length} file{run.changedFiles.length === 1 ? '' : 's'} changed by agents
            {run.engineModel ? ` · ${run.engineModel}` : ''}
            {run.origin === 'web' ? ` · started from the web by ${run.requestedBy?.displayName ?? 'someone'}` : ''}
          </p>
          <ol className="steps">
            {run.steps.map((s) => (
              <li key={s.stepId} className={`step step-${s.status}`}>
                <div className="row">
                  <span className="step-icon">{STEP_ICON[s.status] ?? '•'}</span>
                  <span className="grow">{s.label}</span>
                  <span className="tag">{s.kind}</span>
                  {s.agentName || s.agentSlug ? <span className="tag">{s.agentName ?? s.agentSlug}</span> : null}
                  {s.gatePass !== null ? <span className={cx('tag', s.gatePass ? 'ok' : 'warn')}>{s.gatePass ? 'gate passed' : 'gate failed'}</span> : null}
                  {s.approval ? <span className={cx('tag', s.approval.approve ? 'ok' : 'warn')}>{s.approval.approve ? 'approved' : 'rejected'}</span> : null}
                </div>
                {s.skills.length || s.skillsUsed.length ? (
                  <p className="muted indent">
                    Skills:{' '}
                    {[...new Set([...s.skills, ...s.skillsUsed.map((u) => u.slug)])]
                      .map((slug) => (s.skillsUsed.some((u) => u.slug === slug) ? `${slug} (used)` : slug))
                      .join(', ')}
                    {s.toolCalls !== null ? ` · ${s.toolCalls} tool calls` : ''}
                  </p>
                ) : s.toolCalls !== null ? (
                  <p className="muted indent">{s.toolCalls} tool calls</p>
                ) : null}
                {s.gateReason && s.gatePass === false ? <p className="muted indent">{s.gateReason}</p> : null}
                <Evaluations evaluations={s.evaluations} reportUrl={s.reportUrl} />
                {s.plan ? (
                  <details className="indent">
                    <summary>Plan</summary>
                    <pre className="output">{s.plan}</pre>
                  </details>
                ) : null}
                {s.approval?.comment ? <p className="muted indent">“{s.approval.comment}”{s.approval.actor ? ` — ${s.approval.actor}` : ''}</p> : null}
                {s.error ? <p className="error indent">{s.error}</p> : null}
                {s.output ? (
                  <details className="indent">
                    <summary>Output</summary>
                    <pre className="output">{s.output}</pre>
                  </details>
                ) : null}
                {s.changedFiles.length ? <p className="muted indent mono">{s.changedFiles.join(', ')}</p> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  )
}

function TrackingNote({ tracking }: { tracking: PanelTracking }) {
  switch (tracking.kind) {
    case 'tracking':
      return <p className="notice ok">This window is reporting your work on this story ({tracking.files} file{tracking.files === 1 ? '' : 's'} changed).</p>
    case 'not-yours':
      return <p className="notice">Your edits aren’t reported here: the story isn’t assigned to you.</p>
    case 'off':
      return <p className="notice">Code activity tracking is off (sdlcGovernance.platform.trackCodeActivity).</p>
    case 'offline':
      return <p className="notice error">Can’t reach the platform: {tracking.message}</p>
    default:
      return <p className="muted">Check out the story branch to report your work here automatically.</p>
  }
}

export function CodeTab({ work, tracking, diffs, onLoadDiff }: Props) {
  if (!work) return <p className="muted">Code activity could not be loaded.</p>
  return (
    <div className="stack">
      <TrackingNote tracking={tracking} />
      <section>
        <h3>Working now</h3>
        {work.workspaces.length === 0 ? <p className="muted">Nobody has reported uncommitted work on this story.</p> : work.workspaces.map((w) => <Workspace key={w.user.id} w={w} diffs={diffs} onLoadDiff={onLoadDiff} />)}
      </section>
      <section>
        <h3>Commits ({work.commits.length})</h3>
        {work.commits.length === 0 ? <p className="muted">No commits reported on the story branch yet.</p> : <ul className="list">{work.commits.map((c) => <Commit key={c.sha} c={c} diffs={diffs} onLoadDiff={onLoadDiff} />)}</ul>}
      </section>
      <section>
        <h3>Agent runs ({work.runs.length})</h3>
        {work.runs.length === 0 ? <p className="muted">No workflow runs on this story yet.</p> : <ul className="list">{work.runs.map((r) => <Run key={r.id} run={r} />)}</ul>}
      </section>
    </div>
  )
}
