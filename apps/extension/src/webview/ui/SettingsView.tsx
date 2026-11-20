// Settings tab — lets the user pick their preferred AI assistant for the Start button,
// and reorder the workflow's agent chain without wiring nodes by hand on the canvas.

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { Edge } from '@xyflow/react'
import { vscode } from './vscodeApi'
import type { AiAssistant, HostToWebview } from '../messages'
import { getAgentOrder, type BuilderNode } from './builderUtils'

const ASSISTANTS: { id: AiAssistant; label: string; kind: string; desc: string }[] = [
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    kind: 'chat · @sdlc participant',
    desc: 'Opens Copilot Chat with the @sdlc participant pre-seeded with the workflow name.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'extension',
    desc: 'Opens the Claude Code extension with your Azure Boards work item and the workflow’s agents pre-seeded as one prompt. Installs the extension automatically if it’s missing.',
  },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'extension',
    desc: 'Opens the Codex extension (installing it automatically if needed) and copies your seeded workflow prompt to the clipboard to paste in.',
  },
]

interface Props {
  nodes: BuilderNode[]
  edges: Edge[]
  isReadOnly: boolean
  onReorderAgents: (newAgentOrder: string[]) => void
}

export function SettingsView({ nodes, edges, isReadOnly, onReorderAgents }: Props): JSX.Element {
  const [selected, setSelected] = useState<AiAssistant>('copilot')

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostToWebview
      if (msg.type === 'aiPreferenceLoaded') setSelected(msg.assistant)
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'getAiPreference' })
    return () => window.removeEventListener('message', handler)
  }, [])

  const pick = (id: AiAssistant) => {
    setSelected(id)
    vscode.postMessage({ type: 'setAiPreference', assistant: id })
  }

  return (
    <div className="settings-view">
      <h3 className="settings-view__title">AI Assistant</h3>
      <p className="settings-view__subtitle">
        Used by <strong>Run Workflow in Chat (@sdlc)</strong>. <strong>▶ Start</strong> runs in your harness from the SDLC
        platform (your Agent engine preference, if the project allows it), and asks when more than one is installed.
      </p>
      <div className="settings-view__cards" role="radiogroup" aria-label="AI assistant preference">
        {ASSISTANTS.map(({ id, label, kind, desc }) => (
          <button
            key={id}
            role="radio"
            aria-checked={selected === id}
            className={`settings-card${selected === id ? ` settings-card--selected settings-card--${id}` : ''}`}
            onClick={() => pick(id)}
          >
            <span className="settings-card__label">{label}</span>
            <span className="settings-card__kind">{kind}</span>
            <span className="settings-card__desc">{desc}</span>
          </button>
        ))}
      </div>

      <AgentOrderSection nodes={nodes} edges={edges} isReadOnly={isReadOnly} onReorderAgents={onReorderAgents} />
    </div>
  )
}

function AgentOrderSection({ nodes, edges, isReadOnly, onReorderAgents }: Props): JSX.Element {
  const agentOrder = getAgentOrder(nodes, edges)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= agentOrder.length) return
    const ids = agentOrder.map((a) => a.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    onReorderAgents(ids)
  }

  const handleNumberChange = (index: number, raw: string): void => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const clamped = Math.min(Math.max(Math.round(value), 1), agentOrder.length)
    move(index, clamped - 1)
  }

  return (
    <div className="settings-view__agent-order">
      <h3 className="settings-view__title">Agent Execution Order</h3>
      <p className="settings-view__subtitle">
        The order agents run in, top to bottom. Drag a row or edit its number to rewire the flow — no need to
        move nodes on the canvas. <strong>Start</strong> and <strong>End</strong> always stay in place.
      </p>

      {agentOrder.length === 0 ? (
        <div className="agent-order__empty">No agents in this workflow yet — add one from the canvas.</div>
      ) : (
        <ol className="agent-order__list">
          {agentOrder.map((entry, index) => (
            <li
              key={entry.id}
              className={`agent-order__row${dragIndex === index ? ' agent-order__row--dragging' : ''}${overIndex === index && dragIndex !== null && dragIndex !== index ? ' agent-order__row--over' : ''}`}
              draggable={!isReadOnly}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragIndex !== null) setOverIndex(index)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex !== null) move(dragIndex, index)
                setDragIndex(null)
                setOverIndex(null)
              }}
              onDragEnd={() => {
                setDragIndex(null)
                setOverIndex(null)
              }}
            >
              <span className="agent-order__handle" title={isReadOnly ? undefined : 'Drag to reorder'}>⠿</span>
              <input
                className="agent-order__number"
                type="number"
                min={1}
                max={agentOrder.length}
                value={index + 1}
                disabled={isReadOnly}
                onChange={(e) => handleNumberChange(index, e.target.value)}
              />
              <span className="agent-order__label">{entry.label}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
