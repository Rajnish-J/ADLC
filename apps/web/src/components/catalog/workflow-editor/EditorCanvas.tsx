'use client'

// The editable canvas: drag steps around, drop new ones from the palette, connect a step's right handle to
// another's left handle, select to edit, Delete / Backspace to remove. Connections that can never be valid
// (into the start, out of an end, onto itself, duplicates) are refused while dragging.

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { useTheme } from 'next-themes'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { NODE_HEIGHT, NODE_WIDTH } from '@sdlc/core'
import { editorNodeTypes, StepIssuesContext } from './EditorNode'
import { PALETTE_MIME, worstIssueByNode, type PalettePayload } from './editorModel'
import type { WorkflowEditorState } from './useWorkflowEditor'

/** Whether a key press belongs to a text field or an open menu rather than the canvas. */
function typingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true
  return !!target.closest('[role="dialog"], [role="menu"], [role="listbox"], [cmdk-root]')
}

export default function EditorCanvas({ editor, readOnly }: { editor: WorkflowEditorState; readOnly: boolean }) {
  const { resolvedTheme } = useTheme()
  const { screenToFlowPosition } = useReactFlow()
  const issueByNode = useMemo(() => worstIssueByNode(editor.issues), [editor.issues])
  const { deleteSelection, dropStep } = editor
  // Long pipelines are unreadable fitted whole: open on the first steps at a legible zoom, like the read-only canvas.
  const [opening] = useState(() =>
    [...editor.nodes]
      .sort((a, b) => a.position.x - b.position.x)
      .slice(0, 3)
      .map((n) => ({ id: n.id })),
  )

  // Delete / Backspace removes the selection — handled here (not by React Flow) so the start step, the last
  // end step and chain bridging follow the same rules as the inspector's Delete button.
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || typingElsewhere(e.target)) return
      e.preventDefault()
      deleteSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly, deleteSelection])

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(PALETTE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      const raw = e.dataTransfer.getData(PALETTE_MIME)
      if (!raw) return
      e.preventDefault()
      let payload: PalettePayload
      try {
        payload = JSON.parse(raw) as PalettePayload
      } catch {
        return
      }
      // Centre the new step under the cursor.
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      dropStep(payload, { x: Math.round(at.x - NODE_WIDTH / 2), y: Math.round(at.y - NODE_HEIGHT / 2) })
    },
    [screenToFlowPosition, dropStep],
  )

  return (
    <StepIssuesContext.Provider value={issueByNode}>
      <div className="workflow-canvas size-full" onDragOver={readOnly ? undefined : onDragOver} onDrop={readOnly ? undefined : onDrop}>
        <ReactFlow
          nodes={editor.nodes}
          edges={editor.edges}
          nodeTypes={editorNodeTypes}
          onNodesChange={editor.onNodesChange}
          onEdgesChange={editor.onEdgesChange}
          onConnect={readOnly ? undefined : editor.connect}
          isValidConnection={editor.isValidConnection}
          onPaneClick={() => editor.selectStep(null)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[20, 20]}
          colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
          fitView
          fitViewOptions={{ nodes: opening, padding: 0.12, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
          connectionRadius={28}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap pannable zoomable className="hidden md:block" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </StepIssuesContext.Provider>
  )
}
