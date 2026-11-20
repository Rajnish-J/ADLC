// Phase 5A — the React Flow nodeTypes registry. One stable component per SpecNodeKind (all delegate
// to BaseNode with their kind), keyed by the same string specToFlow puts on `node.type`. Defined at
// module scope so identities are stable across renders (React Flow requires this).

import type { JSX } from 'react'
import type { NodeTypes } from '@xyflow/react'
import type { SpecNodeKind } from '../../../runtime/spec'
import { BaseNode, type GovNode } from './BaseNode'
import type { NodeProps } from '@xyflow/react'

const KINDS: SpecNodeKind[] = [
  'trigger',
  'agent',
  'gate',
  'approval',
  'condition',
  'set-variable',
  'goto',
  'end',
]

/** Build a distinct, display-named component for a kind (delegates rendering to BaseNode). */
function makeNode(kind: SpecNodeKind): (props: NodeProps<GovNode>) => JSX.Element {
  const Comp = (props: NodeProps<GovNode>): JSX.Element => <BaseNode {...props} />
  Comp.displayName = `Node_${kind}`
  return Comp
}

export const nodeTypes: NodeTypes = Object.fromEntries(
  KINDS.map((k) => [k, makeNode(k)]),
) as NodeTypes
