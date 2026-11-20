'use client'

// A step on the editor canvas: the shared node card, selectable, with grabbable handles and the step's worst
// problem (from the editor's live checks) as a badge.

import { createContext, memo, useContext, type JSX } from 'react'
import type { NodeProps } from '@xyflow/react'
import { nodeSubtitle, type SpecNodeKind } from '@sdlc/core'
import { KIND_STYLE, WorkflowNodeCard } from '../WorkflowNodeCard'
import type { EditorNode as EditorNodeT, StepIssue } from './editorModel'

/** The worst issue per step id — provided by the editor so nodes needn't receive it through their data. */
export const StepIssuesContext = createContext<Map<string, StepIssue>>(new Map())

function EditorNodeView({ id, data, selected }: NodeProps<EditorNodeT>): JSX.Element {
  const issue = useContext(StepIssuesContext).get(id)
  return (
    <WorkflowNodeCard
      kind={data.kind}
      label={data.label || 'Untitled step'}
      subtitle={nodeSubtitle({ kind: data.kind, data: data.specData })}
      agentId={data.specData.agentId}
      harness={data.specData.harness}
      selected={selected}
      issue={issue}
      editable
    />
  )
}

const EditorNode = memo(EditorNodeView)

export const editorNodeTypes = Object.fromEntries((Object.keys(KIND_STYLE) as SpecNodeKind[]).map((k) => [k, EditorNode]))
