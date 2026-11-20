// NodePalette — left-side draggable node type sidebar for the workflow builder.
// Each item stores its kind in dataTransfer so BuilderShell can create a node on drop.

import type { JSX } from 'react'
import type { SpecNodeKind } from '../../runtime/spec'
import { VISUALS } from './nodes/BaseNode'

interface PaletteKind {
  kind: SpecNodeKind
  label: string
}

// 'trigger' excluded — workflows have exactly one start node (already in every new spec)
const PALETTE_KINDS: PaletteKind[] = [
  { kind: 'agent', label: 'Agent' },
  { kind: 'gate', label: 'Gate' },
  { kind: 'approval', label: 'Approval' },
  { kind: 'condition', label: 'Condition' },
  { kind: 'set-variable', label: 'Set Variable' },
  { kind: 'goto', label: 'Go To' },
  { kind: 'end', label: 'End' },
]

interface Props {
  isReadOnly: boolean
}

export function NodePalette({ isReadOnly }: Props): JSX.Element | null {
  if (isReadOnly) return null

  return (
    <div className="node-palette">
      <div className="node-palette__heading">Nodes</div>
      {PALETTE_KINDS.map(({ kind, label }) => {
        const v = VISUALS[kind]
        return (
          <div
            key={kind}
            className="node-palette__item"
            style={{ borderLeftColor: v.accent }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/reactflow-node-kind', kind)
              e.dataTransfer.effectAllowed = 'move'
            }}
            title={`Drag to add a ${label} node`}
          >
            <span className="node-palette__icon" style={{ color: v.accent }}>
              {v.icon}
            </span>
            <span>{label}</span>
          </div>
        )
      })}
    </div>
  )
}
