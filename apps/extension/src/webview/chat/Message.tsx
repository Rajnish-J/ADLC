// One chat message in the VS Code panel: the user's as a bubble; the assistant's as markdown with its tool calls
// in order — lookups as compact rows, changes as Approve / Reject cards, questions and hand-offs as cards.

import { useMemo, useState } from 'react'
import MarkdownIt from 'markdown-it'
import type { UIMessage } from 'ai'
import type { AskUserInput, AskUserOutput, ChatAgentSummary, DraftRef, DraftSubmittedData, HandoffInput } from '@sdlc/contracts'

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

type ToolPart = {
  type: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean }
}

const DRAFT_TOOLS = new Set(['update_draft', 'load_workflow_into_draft', 'load_agent_into_draft', 'load_skill_into_draft'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MessageHandlers {
  onAnswer: (toolCallId: string, output: AskUserOutput) => void
  onDecide: (approvalId: string, approved: boolean, reason?: string) => void
  onHandoff: (toolCallId: string, input: HandoffInput) => void
  onReview: () => void
  onOpenRef: (ref: DraftRef) => void
}

interface Props extends MessageHandlers {
  message: UIMessage
  interactive: boolean
  labels: Map<string, string>
  agents: ChatAgentSummary[]
}

/** Small status glyphs (the webview has no codicon font). */
export function Glyph({ kind }: { kind: 'ok' | 'err' | 'denied' | 'busy' | 'edit' }) {
  if (kind === 'busy') return <span className="spinner" aria-label="Working" />
  const map = { ok: ['✓', 'ok'], err: ['!', 'err'], denied: ['⊘', 'muted'], edit: ['✎', 'accent'] } as const
  const [char, cls] = map[kind]
  return <span className={`glyph ${cls}`}>{char}</span>
}

const human = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ')
const failed = (o: unknown) => (o && typeof o === 'object' && (o as { ok?: unknown }).ok === false ? String((o as { error?: unknown }).error ?? 'Failed') : null)

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.render(text), [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

function ToolRow({ part, label }: { part: ToolPart; label: string }) {
  const [open, setOpen] = useState(false)
  const running = ['input-streaming', 'input-available', 'approval-responded'].includes(part.state)
  const error = part.state === 'output-error' ? (part.errorText ?? 'Failed') : failed(part.output)
  const glyph = running ? 'busy' : part.state === 'output-denied' ? 'denied' : error ? 'err' : 'ok'
  return (
    <div className="tool-row">
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <Glyph kind={glyph} />
        <span className="tool-label">{label}</span>
        {part.state === 'output-denied' ? <span className="muted">— rejected</span> : null}
        {error ? <span className="err ellipsis">— {error}</span> : null}
        <span className={`chevron push ${open ? 'open' : ''}`}>›</span>
      </button>
      {open ? (
        <pre className="tool-json">
          {JSON.stringify(part.input ?? {}, null, 2)}
          {part.output !== undefined ? `\n\n${JSON.stringify(part.output, null, 2)}` : ''}
        </pre>
      ) : null}
    </div>
  )
}

function Approval({ part, label, active, onDecide }: { part: ToolPart; label: string; active: boolean; onDecide: Props['onDecide'] }) {
  const [reason, setReason] = useState('')
  const rows = Object.entries((part.input ?? {}) as Record<string, unknown>).filter(([, v]) => v !== null && v !== '')
  const id = part.approval?.id ?? ''
  return (
    <div className="card approval">
      <div className="card-title">
        Approve: {label}?
      </div>
      <dl className="summary">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === 'string' ? (UUID.test(v) ? `${v.slice(0, 8)}…` : v) : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
      <input className="input" placeholder="Reason, if you reject (optional)" value={reason} disabled={!active} onChange={(e) => setReason(e.target.value)} />
      <div className="actions">
        <button type="button" className="secondary" disabled={!active} onClick={() => onDecide(id, false, reason.trim() || undefined)}>
          Reject
        </button>
        <button type="button" disabled={!active} onClick={() => onDecide(id, true)}>
          Approve
        </button>
      </div>
    </div>
  )
}

function AskUser({ part, active, onAnswer }: { part: ToolPart; active: boolean; onAnswer: Props['onAnswer'] }) {
  const questions = (part.input as AskUserInput | undefined)?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const value = (id: string, def: string | null) => answers[id] ?? def ?? ''
  if (part.state === 'output-available') {
    const out = part.output as AskUserOutput
    return (
      <div className="card answered">
        <div className="muted small">{out.skipped ? 'Skipped — the assistant will use its defaults' : 'Your answers'}</div>
        {out.answers.map((a) => (
          <div key={a.id}>
            <span className="muted">{a.question}</span> <strong>{a.answer || '—'}</strong>
          </div>
        ))}
      </div>
    )
  }
  const send = (skipped: boolean) =>
    onAnswer(part.toolCallId, { skipped, answers: skipped ? [] : questions.map((q) => ({ id: q.id, question: q.question, answer: value(q.id, q.defaultValue).trim() })) })
  return (
    <div className="card">
      <div className="muted small">
        {questions.length === 1 ? 'A question for you' : `${questions.length} questions for you`}
      </div>
      {questions.map((q) => {
        const v = value(q.id, q.defaultValue)
        return (
          <div key={q.id} className="question">
            <div className="strong">{q.question}</div>
            <div className="chips">
              {q.options.map((o) => (
                <button key={o} type="button" className={`chip ${v === o ? 'on' : ''}`} disabled={!active} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}>
                  {o}
                  {o === q.defaultValue ? <span className="muted"> · suggested</span> : null}
                </button>
              ))}
            </div>
            <input
              className="input"
              placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
              value={q.options.includes(v) ? '' : v}
              disabled={!active}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            />
          </div>
        )
      })}
      <div className="actions">
        <button type="button" className="secondary" disabled={!active} onClick={() => send(true)}>
          Skip
        </button>
        <button type="button" disabled={!active || questions.length === 0} onClick={() => send(false)}>
          Send answers
        </button>
      </div>
    </div>
  )
}

export default function Message(props: Props) {
  const { message } = props
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    return <div className="bubble">{text}</div>
  }
  return (
    <div className="assistant">
      {message.parts.map((raw, i) => {
        if (raw.type === 'text') return raw.text ? <Markdown key={i} text={raw.text} /> : null
        if (raw.type === 'reasoning') return null
        if (raw.type === 'data-draft-submitted') {
          const data = (raw as unknown as { data: DraftSubmittedData }).data
          return (
            <div key={i} className="card submitted">
              <Glyph kind="ok" /> <span className="grow">{data.label}</span>
              <button type="button" className="secondary" onClick={() => props.onOpenRef(data.ref)}>
                Open
              </button>
            </div>
          )
        }
        if (!raw.type.startsWith('tool-')) return null
        const part = raw as unknown as ToolPart
        const name = part.type.slice(5)
        const label = props.labels.get(name) ?? human(name)
        const waiting = props.interactive && part.state === 'input-available'
        if (name === 'ask_user') return <AskUser key={part.toolCallId} part={part} active={waiting} onAnswer={props.onAnswer} />
        if (name === 'handoff') {
          const input = part.input as HandoffInput | undefined
          const target = props.agents.find((a) => a.name === input?.agent)
          return (
            <div key={part.toolCallId} className="card handoff">
              <span className="grow">
                <strong>{target ? `${target.label} specialist` : 'A specialist'} can take this</strong>
                {input?.brief ? <div className="muted small">{input.brief}</div> : null}
              </span>
              {part.state === 'output-available' ? (
                <span className="muted small">Switched</span>
              ) : (
                <button type="button" disabled={!waiting || !target} onClick={() => input && props.onHandoff(part.toolCallId, input)}>
                  Continue
                </button>
              )}
            </div>
          )
        }
        if (DRAFT_TOOLS.has(name)) {
          const out = part.output as { errors?: string[]; ready?: boolean } | undefined
          const done = part.state === 'output-available'
          return (
            <div key={part.toolCallId} className="tool-row draft">
              <Glyph kind={done ? 'edit' : 'busy'} />
              <span className="tool-label">{done ? 'Updated the draft' : 'Updating the draft…'}</span>
              {out?.errors?.length ? <span className="warn">{out.errors.length} to fix</span> : null}
              {out?.ready ? <span className="ok">ready</span> : null}
              {done ? (
                <button type="button" className="link push" onClick={props.onReview}>
                  Review
                </button>
              ) : null}
            </div>
          )
        }
        if (part.state === 'approval-requested') return <Approval key={part.toolCallId} part={part} label={label} active={props.interactive} onDecide={props.onDecide} />
        return <ToolRow key={part.toolCallId} part={part} label={label} />
      })}
    </div>
  )
}
