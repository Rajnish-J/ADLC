// The Run monitor view's markup: the same agent map as the web's run monitor (orchestrator → steps → subagents, any
// approval the run waits on, where it is in the workflow), rendered to HTML from `buildRunMap`. Pure and free of
// `vscode`, so it is unit-tested; every value is escaped. The webview script only swaps it in and posts clicks back.

import { formatElapsed, formatTokens, type RunMap, type RunMapNode, type RunMapStatus } from '@sdlc/core'
import { harnessLabel } from '@sdlc/contracts'

export interface RunOption {
  runId: string
  projectKey: string
  label: string
  status: string
}

export interface RunMonitorModel {
  connected: boolean
  runs: RunOption[]
  followed: RunOption | null
  map: RunMap | null
  /** The approval the followed run waits on (the plan or the latest agent's output is in `context`). */
  pending: { stepId: string; question: string; context?: string; agentName?: string; kind?: string } | null
  error: string | null
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const LABEL: Record<RunMapStatus, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  queued: 'Queued',
  pending: 'Waiting for VS Code',
  done: 'Done',
  failed: 'Stopped',
  skipped: 'Skipped',
}

const dot = (s: RunMapStatus): string => `<span class="dot ${s}" title="${esc(LABEL[s])}"></span>`

function step(n: RunMapNode, current: boolean): string {
  const title = n.kind === 'agent' ? (n.agentName ?? n.label) : n.label
  const kind = n.kind === 'agent' ? n.label : n.kind === 'gate' ? 'Quality gate' : n.kind === 'approval' ? 'Approval' : n.kind
  const meta = [kind, n.harness ? harnessLabel(n.harness) : null, formatElapsed(n.elapsedMs), n.tokens !== null ? `${formatTokens(n.tokens)} tokens` : null]
    .filter(Boolean)
    .join(' · ')
  const live = n.status === 'running' || n.status === 'waiting'
  const details = [
    `<div><span>Tool calls</span><b>${n.toolCalls}</b></div>`,
    `<div><span>Files</span><b>${n.files}</b></div>`,
    n.skills.length ? `<div><span>Skills</span><b>${esc(n.skills.join(', '))}</b></div>` : '',
    !live && n.lastActivity ? `<div class="wide"><span>Last</span><b>${esc(n.lastActivity)}</b></div>` : '',
  ].join('')
  const subs = n.subAgents.length
    ? `<ul class="subs">${n.subAgents
        .map((a) => `<li>${dot(a.status === 'running' ? 'running' : 'done')}<span class="name">${esc(a.name)}</span><span class="muted">${formatElapsed(a.elapsedMs)}</span></li>`)
        .join('')}</ul>`
    : ''
  return `<li class="step">
    <button class="card${current ? ' current' : ''}" data-action="toggle" data-step="${esc(n.stepId)}">
      <div class="row">${dot(n.status)}<span class="title">${esc(title)}</span></div>
      <div class="meta">${esc(meta)}</div>
      ${live && n.lastActivity ? `<div class="activity">${esc(n.lastActivity)}</div>` : ''}
    </button>
    <div class="details" data-details="${esc(n.stepId)}">${details}</div>
    ${subs}
  </li>`
}

export function renderRunMonitor(m: RunMonitorModel): string {
  if (!m.connected) return `<p class="empty">Connect VS Code to the SDLC platform to follow your workflow runs here.</p>`
  if (m.error) return `<p class="error">${esc(m.error)}</p>`
  if (!m.followed) return `<p class="empty">No runs right now. Start one from a story (Stories view) or from the web — it shows up here live.</p>`
  const picker =
    m.runs.length > 1
      ? `<select data-action="pick" aria-label="Run to follow">${m.runs
          .map((r) => `<option value="${esc(r.runId)}" data-project="${esc(r.projectKey)}"${r.runId === m.followed?.runId ? ' selected' : ''}>${esc(r.label)} · ${esc(r.status.replace('_', ' '))}</option>`)
          .join('')}</select>`
      : ''
  if (!m.map) return `${picker}<p class="empty">Loading ${esc(m.followed.label)}…</p>`
  const o = m.map.orchestrator
  const steps = m.map.nodes.filter((n) => n.kind !== 'trigger')
  const orchestratorMeta = [m.followed.label, LABEL[o.status], formatElapsed(o.elapsedMs), o.tokens !== null ? `${formatTokens(o.tokens)} tokens` : null].filter(Boolean).join(' · ')
  const approval = m.pending
    ? `<section class="approval">
        <div class="row">${dot('waiting')}<b>${esc(m.pending.question)}</b></div>
        ${m.pending.context ? `<details><summary>${esc(m.pending.kind === 'approval' ? `${m.pending.agentName ?? 'Previous step'}'s output` : `${m.pending.agentName ?? 'Agent'}'s plan`)}</summary><pre>${esc(m.pending.context)}</pre></details>` : ''}
        <div class="buttons">
          <button class="primary" data-action="approve" data-step="${esc(m.pending.stepId)}">Approve</button>
          <button data-action="reject" data-step="${esc(m.pending.stepId)}">Reject…</button>
        </div>
      </section>`
    : ''
  const flow = m.map.flow.length
    ? `<section><h3>Workflow</h3><ol class="flow">${m.map.flow
        .map((f) => `<li class="${f.state}">${dot(f.state)}<span>${esc(f.label)}${f.state === 'waiting' ? ' — waiting for you' : f.state === 'running' ? ' — in progress' : ''}</span></li>`)
        .join('')}</ol></section>`
    : ''
  const live = ['running', 'waiting', 'queued', 'pending'].includes(o.status)
  return `${picker}
    <div class="card orchestrator">
      <div class="row">${dot(o.status)}<span class="title">Orchestrator · ${esc(o.label)}</span></div>
      <div class="meta">${esc(orchestratorMeta)}</div>
      ${o.activity ? `<div class="activity">${esc(o.activity)}</div>` : ''}
    </div>
    ${steps.length ? `<ul class="tree">${steps.map((n) => step(n, n.nodeId === m.map?.currentNodeId)).join('')}</ul>` : '<p class="empty indent">No step has started yet.</p>'}
    ${approval}
    ${flow}
    <div class="footer">
      <button data-action="open">Open on the web</button>
      ${live ? '<button class="danger" data-action="stop">Stop</button>' : ''}
    </div>`
}

/** The view's stylesheet: VS Code theme colours only. */
export const RUN_MONITOR_CSS = `
body { padding: 8px 10px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
.empty, .error { color: var(--vscode-descriptionForeground); margin: 12px 2px; line-height: 1.4; }
.error { color: var(--vscode-errorForeground); }
.indent { margin-left: 22px; }
select { width: 100%; margin-bottom: 10px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 3px 4px; }
.card { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 7px 9px; cursor: pointer; }
.card:hover { background: var(--vscode-list-hoverBackground); }
.card.current { border-color: var(--vscode-focusBorder); }
.orchestrator { cursor: default; }
.row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta, .muted { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
.meta { margin: 2px 0 0 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity { margin: 3px 0 0 15px; font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); opacity: .5; }
.dot.running { background: var(--vscode-charts-blue); opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
.dot.waiting { background: var(--vscode-charts-yellow); opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
.dot.done { background: var(--vscode-charts-green); opacity: 1; }
.dot.failed { background: var(--vscode-charts-red); opacity: 1; }
.dot.queued { background: var(--vscode-charts-purple); opacity: 1; }
@keyframes pulse { 50% { opacity: .35; } }
.tree { list-style: none; margin: 8px 0 0 10px; padding: 0 0 0 12px; border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); display: flex; flex-direction: column; gap: 7px; }
.step { position: relative; }
.step::before { content: ''; position: absolute; left: -12px; top: 16px; width: 12px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.details { display: none; grid-template-columns: 1fr 1fr; gap: 3px 10px; margin-top: 4px; padding: 6px 9px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); font-size: 0.92em; }
.details.open { display: grid; }
.details div { display: flex; justify-content: space-between; gap: 6px; min-width: 0; }
.details .wide { grid-column: 1 / -1; }
.details span { color: var(--vscode-descriptionForeground); }
.details b { font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subs { list-style: none; margin: 5px 0 0 10px; padding: 0 0 0 10px; border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.subs li { display: flex; align-items: center; gap: 6px; font-size: 0.92em; padding: 1px 0; }
.subs .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subs .dot { width: 6px; height: 6px; }
section { margin-top: 14px; }
h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); margin: 0 0 6px; }
.flow { list-style: none; margin: 0; padding: 0; }
.flow li { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 0.95em; }
.flow li.pending { color: var(--vscode-descriptionForeground); }
.flow li.running, .flow li.waiting { font-weight: 600; }
.approval { border: 1px solid var(--vscode-charts-yellow); border-radius: 6px; padding: 8px 9px; }
.approval details { margin-top: 6px; }
.approval pre { white-space: pre-wrap; max-height: 220px; overflow: auto; font-size: 0.9em; background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 4px; }
.buttons, .footer { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.footer { border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding-top: 10px; margin-top: 14px; }
button:not(.card) { font: inherit; padding: 3px 10px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.danger { margin-left: auto; color: var(--vscode-errorForeground); background: transparent; }
`
