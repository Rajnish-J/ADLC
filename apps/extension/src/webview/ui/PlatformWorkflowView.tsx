// A project workflow from the SDLC platform: the same read-only canvas the web app shows, beside an "Agent mapping"
// panel that mirrors the web's StepMapping — which agent runs each agent step, and the harness it runs in (unset =
// the harness the run starts with). Leads and owners (workflow.edit) pick from the project's enabled agents they
// may use; everyone else sees the mapping read-only. The host calls the API (which re-checks everything) and
// re-renders with the new spec. ▶ Start runs it on a story in the selected harness.

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react'
import type { PlatformAgentOption, PlatformWorkflowView as View } from '../messages'
import { nodeTypes } from './nodes'
import type { GovNode } from './nodes/BaseNode'
import { buildEdges, buildNodes } from './readOnlyFlow'
import { onHostMessage, vscode } from './vscodeApi'

const NONE = '__none'
const RUN_DEFAULT = '__default'

const mappable = (a: PlatformAgentOption): boolean => a.enabled && a.usable

function Canvas({ view, selected, onSelect }: { view: View; selected?: string; onSelect: (id: string | undefined) => void }): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<GovNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    setNodes(buildNodes(view.spec, {}).map((n) => ({ ...n, selected: n.id === selected })))
    setEdges(buildEdges(view.spec, {}))
  }, [view.spec, selected, setNodes, setEdges])

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => onSelect(view.spec.nodes.find((n) => n.id === node.id)?.kind === 'agent' ? node.id : undefined),
    [view.spec, onSelect],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onPaneClick={() => onSelect(undefined)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

function StepMapping({ view, busy, selected, onSelect }: { view: View; busy: string | null; selected?: string; onSelect: (id: string) => void }): JSX.Element {
  const steps = view.spec.nodes.filter((n) => n.kind === 'agent')
  const bySlug = useMemo(() => new Map(view.agents.map((a) => [a.slug, a])), [view.agents])
  const options = view.agents.filter(mappable)
  const harnesses = view.harnesses ?? []
  const harnessName = (id: string): string => harnesses.find((h) => h.id === id)?.label ?? id

  return (
    <aside className="step-mapping">
      <div className="step-mapping__header">
        <h3>Agent mapping</h3>
        <p>
          {view.canEdit
            ? 'Choose which agent runs each step. Only agents enabled for this project are offered.'
            : 'Which agent runs each step. Leads and owners can change this.'}
        </p>
      </div>
      {steps.length === 0 ? <p className="step-mapping__empty">This workflow has no agent steps.</p> : null}
      <ol className="step-mapping__list">
        {steps.map((step) => {
          const slug = typeof step.data.agentId === 'string' && step.data.agentId ? step.data.agentId : undefined
          const current = slug ? bySlug.get(slug) : undefined
          const name = current?.name ?? step.data.agentName ?? slug
          const pinned = typeof step.data.harness === 'string' && step.data.harness ? step.data.harness : undefined
          return (
            <li
              key={step.id}
              className={`step-mapping__item ${selected === step.id ? 'step-mapping__item--selected' : ''}`}
              onClick={() => onSelect(step.id)}
            >
              <div className="step-mapping__label">{step.label}</div>
              <div className="step-mapping__desc">
                {!slug ? (
                  <span className="step-mapping__warn">No agent assigned yet</span>
                ) : current && !current.enabled ? (
                  <span className="step-mapping__warn">{name} is disabled in this project</span>
                ) : (
                  <button
                    className="toolbar__link-btn"
                    title="Show this agent's instructions"
                    onClick={(e) => {
                      e.stopPropagation()
                      vscode.postMessage({ type: 'openPlatformAgent', slug })
                    }}
                  >
                    {current?.description || name}
                  </button>
                )}
              </div>
              {view.canEdit ? (
                <select
                  className="step-mapping__select"
                  aria-label={`Agent for ${step.label}`}
                  value={slug ?? NONE}
                  disabled={busy !== null}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const value = e.target.value
                    vscode.postMessage({ type: 'setStepAgent', nodeId: step.id, agentSlug: value === NONE ? null : value })
                  }}
                >
                  <option value={NONE}>No agent</option>
                  {slug && !options.some((a) => a.slug === slug) ? (
                    <option value={slug} disabled>
                      {name}
                    </option>
                  ) : null}
                  {options.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.name}
                      {a.source === 'repo' ? ' · codebase' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`step-mapping__badge ${slug ? '' : 'step-mapping__badge--empty'}`}>{slug ? name : 'Unassigned'}</span>
              )}
              <div className="step-mapping__harness">
                <span className="step-mapping__harness-label">Harness</span>
                {view.canEdit ? (
                  <select
                    className="step-mapping__select"
                    aria-label={`Harness for ${step.label}`}
                    title="Platform runs hand this step to the harness chosen here"
                    value={pinned ?? RUN_DEFAULT}
                    disabled={busy !== null}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const value = e.target.value
                      vscode.postMessage({ type: 'setStepHarness', nodeId: step.id, harness: value === RUN_DEFAULT ? null : value })
                    }}
                  >
                    <option value={RUN_DEFAULT}>Run default</option>
                    {pinned && !harnesses.some((h) => h.id === pinned) ? <option value={pinned}>{pinned}</option> : null}
                    {harnesses.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label}
                        {h.installed ? '' : ' (not installed here)'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`step-mapping__badge ${pinned ? '' : 'step-mapping__badge--empty'}`}>{pinned ? harnessName(pinned) : 'Run default'}</span>
                )}
              </div>
              {busy === step.id ? <span className="step-mapping__busy">Saving…</span> : null}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

export function PlatformWorkflowView({ view }: { view: View }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | undefined>(undefined)

  useEffect(
    () =>
      onHostMessage((msg) => {
        if (msg.type === 'platformBusy') setBusy(msg.nodeId)
        else if (msg.type === 'renderPlatform') setBusy(null)
      }),
    [],
  )

  const unassigned = view.spec.nodes.filter((n) => n.kind === 'agent' && !n.data.agentId).length

  return (
    <div className="builder-shell">
      <div className="toolbar">
        <span className="toolbar__name">{view.name}</span>
        <span className="toolbar__meta">
          {view.projectKey} project workflow · v{view.version}
          {view.isDefault ? ' · default' : ''}
        </span>
        <div className="toolbar__spacer" />
        {unassigned > 0 ? (
          <span className="toolbar__readonly-banner" title="Map an agent to every step before starting a run">
            {unassigned} step{unassigned === 1 ? '' : 's'} without an agent
          </span>
        ) : null}
        <button className="toolbar__btn" onClick={() => vscode.postMessage({ type: 'openPlatformInBrowser' })} title="Open this workflow in the web app">
          ↗ Open in browser
        </button>
        <button className="toolbar__btn" onClick={() => vscode.postMessage({ type: 'refreshPlatform' })} title="Re-fetch the workflow and the project's agents">
          ↻ Refresh
        </button>
        <button
          className="toolbar__btn toolbar__btn--primary"
          onClick={() => vscode.postMessage({ type: 'startPlatformWorkflow' })}
          title="Run this workflow on a story in your selected harness"
        >
          ▶ Start
        </button>
      </div>
      <div className="builder-shell__body">
        <div className="canvas-shell">
          <div className="canvas-shell__flow">
            <ReactFlowProvider>
              <Canvas view={view} selected={selected} onSelect={setSelected} />
            </ReactFlowProvider>
          </div>
        </div>
        <StepMapping view={view} busy={busy} selected={selected} onSelect={setSelected} />
      </div>
    </div>
  )
}
