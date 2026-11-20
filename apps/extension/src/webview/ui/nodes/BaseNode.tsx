// Phase 5A — the shared presentational node. All 8 SpecNodeKinds render through this with a per-kind
// accent + icon + handle layout (see VISUALS). Read-only: no editing affordances. The live overlay
// (status class, glyph, gate/error tooltip) is merged into node `data` by App on each run update.

import { useContext, type JSX } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { SpecNodeKind } from '../../../runtime/spec'
import type { FlowNodeData, NodeOverlay } from '../../../runtime/canvas/specToFlow'
import { statusClass, statusGlyph } from '../overlay'
import { vscode } from '../vscodeApi'
import { BuilderNodeContext } from '../builderContext'

/**
 * What App stores on each React Flow node: the static flow data plus the live overlay. The
 * `Record<string, unknown>` intersection satisfies React Flow's node-data constraint (it requires an
 * index signature) without loosening the named fields.
 */
export type GovNodeData = FlowNodeData & { overlay?: NodeOverlay } & Record<string, unknown>
export type GovNode = Node<GovNodeData>

interface KindVisual {
  icon: string
  accent: string
  hasTarget: boolean
  hasSource: boolean
}

/** Per-kind colour + icon + handle layout. Accents use VS Code chart theme tokens. */
export const VISUALS: Record<SpecNodeKind, KindVisual> = {
  trigger: { icon: '▶', accent: 'var(--vscode-charts-green)', hasTarget: false, hasSource: true },
  agent: { icon: '◆', accent: 'var(--vscode-charts-blue)', hasTarget: true, hasSource: true },
  gate: { icon: '⛨', accent: 'var(--vscode-charts-orange)', hasTarget: true, hasSource: true },
  approval: { icon: '☑', accent: 'var(--vscode-charts-purple)', hasTarget: true, hasSource: true },
  condition: { icon: '⋔', accent: 'var(--vscode-charts-yellow)', hasTarget: true, hasSource: true },
  'set-variable': { icon: '𝑥', accent: 'var(--vscode-charts-blue)', hasTarget: true, hasSource: true },
  goto: { icon: '↩', accent: 'var(--vscode-charts-orange)', hasTarget: true, hasSource: true },
  end: { icon: '■', accent: 'var(--vscode-charts-red)', hasTarget: true, hasSource: false },
}

function tooltipFor(data: GovNodeData): string {
  const o = data.overlay
  const lines = [`${data.label} · ${data.kind}`]
  if (data.subtitle) lines.push(data.subtitle)
  if (o?.gate) lines.push(`gate: ${o.gate.pass ? 'PASS' : 'BLOCKED'} — ${o.gate.reason}`)
  if (o?.plan) lines.push(`plan: ${o.plan}`)
  if (o?.output) lines.push(`done: ${o.output}`)
  if (o?.error) lines.push(`error: ${o.error}`)
  return lines.join('\n')
}

export function BaseNode({ id, data }: NodeProps<GovNode>): JSX.Element {
  const v = VISUALS[data.kind]
  const o = data.overlay
  const { editable, onDeleteNode } = useContext(BuilderNodeContext)
  const cls = ['gov-node', statusClass(o?.status)].filter(Boolean).join(' ')
  return (
    <div className={cls} style={{ borderLeftColor: v.accent }} title={tooltipFor(data)}>
      {editable && onDeleteNode && (
        <button
          className="gov-node__delete-btn"
          title="Delete this node"
          onClick={(e) => {
            e.stopPropagation()
            onDeleteNode(id)
          }}
        >
          🗑
        </button>
      )}
      {v.hasTarget && <Handle type="target" position={Position.Left} />}
      <div className="gov-node__row">
        <span className="gov-node__icon" style={{ color: v.accent }}>
          {v.icon}
        </span>
        <span className="gov-node__label">{data.label}</span>
        {o?.status && (
          <span className={`gov-node__status gov-node__status--${o.status}`}>{statusGlyph(o.status)}</span>
        )}
      </div>
      {data.subtitle && <div className="gov-node__subtitle">{data.subtitle}</div>}
      {data.branch && <div className="gov-node__branch">{data.branch}</div>}
      {data.kind === 'agent' && data.agentId && (
        <div className="gov-node__actions">
          <button
            className="gov-node__action-btn"
            title="Evaluate this agent"
            onClick={(e) => {
              e.stopPropagation()
              vscode.postMessage({ type: 'evaluateAgent', agentId: data.agentId as string })
            }}
          >
            ⚡
          </button>
          <button
            className="gov-node__action-btn"
            title="Govern this agent"
            onClick={(e) => {
              e.stopPropagation()
              vscode.postMessage({ type: 'governAgent', agentId: data.agentId as string })
            }}
          >
            ⛨
          </button>
        </div>
      )}
      {v.hasSource && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
