// Node detail panel — right sidebar shown when a node is selected in the builder.
// Provides kind-specific configuration fields. Changes are applied to local state;
// the user must press Save in the toolbar to persist to disk.

import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Edge } from '@xyflow/react'
import type { BuilderNode, BuilderNodeData } from './builderUtils'
import type { AgentSummary, HarnessOption } from '../messages'
import type { SpecNodeData } from '../../runtime/spec'
import { VISUALS } from './nodes/BaseNode'
import { AddAgentsModal } from './AddAgentsModal'
import { vscode } from './vscodeApi'

interface Props {
  node: BuilderNode
  nodes: BuilderNode[]
  edges: Edge[]
  agents: AgentSummary[]
  /** Harnesses an agent step can be pinned to (sent by the host). */
  harnesses?: HarnessOption[]
  isReadOnly: boolean
  onUpdate: (id: string, patch: Partial<BuilderNodeData>) => void
  onDelete: (id: string) => void
  onReorder: (id: string, dir: 'earlier' | 'later') => void
  onClose: () => void
}

/** Kinds that occupy a step in the linear chain and are safe to reorder. */
const REORDERABLE_KINDS = new Set<BuilderNodeData['kind']>(['agent', 'gate', 'approval', 'set-variable'])

export function NodeDetailPanel({ node, nodes, edges, agents, harnesses = [], isReadOnly, onUpdate, onDelete, onReorder, onClose }: Props): JSX.Element {
  const d = node.data
  const v = VISUALS[d.kind]
  const [label, setLabel] = useState(d.label)
  const [specData, setSpecData] = useState<SpecNodeData>({ ...d.specData })
  const [showAgentPicker, setShowAgentPicker] = useState(false)

  // Reset fields when a different node is selected
  useEffect(() => {
    setLabel(d.label)
    setSpecData({ ...d.specData })
  }, [node.id, d.label, d.specData])

  const linkedAgent = agents.find((a) => a.id === specData.agentId)

  const handleApply = useCallback(() => {
    const subtitle = specData.agentId
      ? (agents.find((a) => a.id === specData.agentId)?.name ?? specData.agentName)
      : specData.sdlcStep
        ? `step: ${specData.sdlcStep}`
        : undefined
    onUpdate(node.id, { label, specData: { ...specData }, subtitle, agentId: specData.agentId })
  }, [node.id, label, specData, agents, onUpdate])

  const patchSpec = (patch: Partial<SpecNodeData>): void => {
    setSpecData((prev) => ({ ...prev, ...patch }))
  }

  const nodeOptions = nodes
    .filter((n) => n.id !== node.id)
    .map((n) => ({ id: n.id, label: n.data.label }))

  // ── Reorder eligibility: node must sit in a single-in / single-out linear segment ──
  const inbound = edges.filter((e) => e.target === node.id)
  const outbound = edges.filter((e) => e.source === node.id)
  const isLinear = REORDERABLE_KINDS.has(d.kind) && inbound.length === 1 && outbound.length === 1
  const predNode = isLinear ? nodes.find((n) => n.id === inbound[0].source) : undefined
  const succNode = isLinear ? nodes.find((n) => n.id === outbound[0].target) : undefined
  const canEarlier = !!predNode && predNode.data.kind !== 'trigger'
  const canLater = !!succNode && succNode.data.kind !== 'end'
  // Start/End are structural — the workflow must always have both, so they can't be deleted.
  const canDelete = d.kind !== 'trigger' && d.kind !== 'end'

  return (
    <div className="detail-panel">
      {showAgentPicker && (
        <AddAgentsModal
          agents={agents}
          onSelect={(agent) => {
            patchSpec({ agentId: agent.id, agentName: agent.name })
            setShowAgentPicker(false)
          }}
          onClose={() => setShowAgentPicker(false)}
        />
      )}

      <div className="detail-panel__header">
        <span style={{ color: v.accent }}>{v.icon}</span>
        <span className="detail-panel__title">{d.kind}</span>
        <button className="detail-panel__close" onClick={onClose} title="Close panel">✕</button>
      </div>

      <div className="detail-panel__body" onBlur={!isReadOnly ? handleApply : undefined}>
        {/* Label — editable for all node types */}
        <label className="detail-panel__field">
          <span>Label</span>
          <input
            className="detail-panel__input"
            value={label}
            disabled={isReadOnly}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        {/* Node id (read-only info) */}
        <label className="detail-panel__field">
          <span>ID</span>
          <input className="detail-panel__input detail-panel__input--muted" value={node.id} readOnly />
        </label>

        {/* ── Kind-specific fields ── */}

        {d.kind === 'trigger' && (
          <>
            <label className="detail-panel__field">
              <span>Trigger Type</span>
              <select
                className="detail-panel__select"
                value={specData.triggerType ?? 'manual'}
                disabled={isReadOnly}
                onChange={(e) =>
                  patchSpec({ triggerType: (e.target.value as SpecNodeData['triggerType']) || undefined })
                }
              >
                <option value="manual">Manual (free-text task)</option>
                <option value="issue">Issue (Azure DevOps work item)</option>
              </select>
            </label>
            {specData.triggerType === 'issue' && (
              <>
                <label className="detail-panel__field">
                  <span>ADO Organization</span>
                  <input
                    className="detail-panel__input"
                    placeholder="(falls back to settings)"
                    value={specData.adoOrg ?? ''}
                    disabled={isReadOnly}
                    onChange={(e) => patchSpec({ adoOrg: e.target.value || undefined })}
                  />
                </label>
                <label className="detail-panel__field">
                  <span>ADO Project</span>
                  <input
                    className="detail-panel__input"
                    placeholder="(falls back to settings)"
                    value={specData.adoProject ?? ''}
                    disabled={isReadOnly}
                    onChange={(e) => patchSpec({ adoProject: e.target.value || undefined })}
                  />
                </label>
                <label className="detail-panel__field">
                  <span>Work Item Type</span>
                  <input
                    className="detail-panel__input"
                    placeholder="User Story"
                    value={specData.workItemType ?? ''}
                    disabled={isReadOnly}
                    onChange={(e) => patchSpec({ workItemType: e.target.value || undefined })}
                  />
                </label>
                <label className="detail-panel__field">
                  <span>WIQL Override (optional)</span>
                  <textarea
                    className="detail-panel__textarea"
                    placeholder="SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me …"
                    value={specData.wiql ?? ''}
                    disabled={isReadOnly}
                    onChange={(e) => patchSpec({ wiql: e.target.value || undefined })}
                  />
                </label>
              </>
            )}
          </>
        )}

        {d.kind === 'agent' && (
          <>
            <div className="detail-panel__field">
              <span>Linked Agent</span>
              {linkedAgent ? (
                <div className="detail-panel__agent-card">
                  <div className="detail-panel__agent-name">{linkedAgent.name}</div>
                  <div className="detail-panel__agent-meta">{linkedAgent.sourceKind} · {linkedAgent.model ?? 'default model'}</div>
                  <div className="detail-panel__agent-desc">{linkedAgent.description}</div>
                  <button
                    className="detail-panel__btn detail-panel__btn--sm"
                    title="Open this agent's manifest (.md)"
                    onClick={() => vscode.postMessage({ type: 'revealNode', nodeId: node.id })}
                  >
                    Open .md
                  </button>
                  {!isReadOnly && (
                    <button className="detail-panel__btn detail-panel__btn--sm" onClick={() => setShowAgentPicker(true)}>
                      Change agent
                    </button>
                  )}
                </div>
              ) : (
                <div className="detail-panel__empty">
                  No agent linked
                  {!isReadOnly && (
                    <button className="detail-panel__btn" onClick={() => setShowAgentPicker(true)}>
                      Add Agent
                    </button>
                  )}
                </div>
              )}
            </div>
            <label className="detail-panel__field">
              <span>SDLC Step</span>
              <select
                className="detail-panel__select"
                value={specData.sdlcStep ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ sdlcStep: (e.target.value as SpecNodeData['sdlcStep']) || undefined })}
              >
                <option value="">(none)</option>
                <option value="design">Design</option>
                <option value="implement">Implement</option>
                <option value="review">Review</option>
                <option value="release">Release</option>
              </select>
            </label>
            <label className="detail-panel__field">
              <span>Output Variable</span>
              <input
                className="detail-panel__input"
                placeholder="Local.AgentResult"
                value={specData.outputVar ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ outputVar: e.target.value || undefined })}
              />
            </label>
            <label className="detail-panel__field" title="Platform runs hand this step to the harness chosen here; runs on this machine's runtime ignore it.">
              <span>Harness</span>
              <select
                className="detail-panel__select"
                value={specData.harness ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ harness: e.target.value || undefined })}
              >
                <option value="">Run default</option>
                {specData.harness && !harnesses.some((h) => h.id === specData.harness) ? (
                  <option value={specData.harness}>{specData.harness}</option>
                ) : null}
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                    {h.installed ? '' : ' (not installed here)'}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {d.kind === 'gate' && (
          <>
            <label className="detail-panel__field">
              <span>Gate Step</span>
              <select
                className="detail-panel__select"
                value={specData.gateStep ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ gateStep: (e.target.value as SpecNodeData['gateStep']) || undefined })}
              >
                <option value="">(none)</option>
                <option value="design">Design</option>
                <option value="implement">Implement</option>
                <option value="review">Review</option>
                <option value="release">Release</option>
              </select>
            </label>
            <label className="detail-panel__field">
              <span>Gate Result Variable</span>
              <input
                className="detail-panel__input"
                placeholder="Local.GateResult"
                value={specData.gateResultVar ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ gateResultVar: e.target.value || undefined })}
              />
            </label>
          </>
        )}

        {d.kind === 'approval' && (
          <>
            <label className="detail-panel__field">
              <span>Question</span>
              <textarea
                className="detail-panel__textarea"
                placeholder="Enter the approval prompt…"
                value={specData.question ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ question: e.target.value || undefined })}
              />
            </label>
            <label className="detail-panel__field">
              <span>Approval Variable</span>
              <input
                className="detail-panel__input"
                placeholder="Local.Approval"
                value={specData.approvalVar ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ approvalVar: e.target.value || undefined })}
              />
            </label>
          </>
        )}

        {d.kind === 'condition' && (
          <>
            <label className="detail-panel__field">
              <span>Branch</span>
              <select
                className="detail-panel__select"
                value={specData.branch ?? 'IF'}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ branch: e.target.value as 'IF' | 'ELSE_IF' | 'ELSE' })}
              >
                <option value="IF">IF</option>
                <option value="ELSE_IF">ELSE IF</option>
                <option value="ELSE">ELSE</option>
              </select>
            </label>
            <label className="detail-panel__field">
              <span>Predicate</span>
              <textarea
                className="detail-panel__textarea"
                placeholder="=Not(Local.GateResult.pass)"
                value={specData.predicate ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ predicate: e.target.value || undefined })}
              />
            </label>
          </>
        )}

        {d.kind === 'set-variable' && (
          <>
            <label className="detail-panel__field">
              <span>Variable</span>
              <input
                className="detail-panel__input"
                placeholder="Local.MyVar"
                value={specData.variable ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ variable: e.target.value || undefined })}
              />
            </label>
            <label className="detail-panel__field">
              <span>Value</span>
              <input
                className="detail-panel__input"
                placeholder="=System.LastMessage.Text"
                value={specData.value ?? ''}
                disabled={isReadOnly}
                onChange={(e) => patchSpec({ value: e.target.value || undefined })}
              />
            </label>
          </>
        )}

        {d.kind === 'goto' && (
          <label className="detail-panel__field">
            <span>Target Node</span>
            <select
              className="detail-panel__select"
              value={specData.targetId ?? ''}
              disabled={isReadOnly}
              onChange={(e) => patchSpec({ targetId: e.target.value || undefined })}
            >
              <option value="">(select)</option>
              {nodeOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label} ({o.id})</option>
              ))}
            </select>
          </label>
        )}

        {/* Reorder in the execution chain — only for linear step nodes in edit mode */}
        {!isReadOnly && isLinear && (canEarlier || canLater) && (
          <div className="detail-panel__field">
            <span>Execution Order</span>
            <div className="detail-panel__reorder">
              <button
                className="detail-panel__btn detail-panel__btn--sm"
                title="Run this step earlier"
                disabled={!canEarlier}
                onClick={() => onReorder(node.id, 'earlier')}
              >
                ↑ Move earlier
              </button>
              <button
                className="detail-panel__btn detail-panel__btn--sm"
                title="Run this step later"
                disabled={!canLater}
                onClick={() => onReorder(node.id, 'later')}
              >
                ↓ Move later
              </button>
            </div>
          </div>
        )}

        {/* Apply + Delete buttons — only in edit mode */}
        {!isReadOnly && (
          <>
            <button className="detail-panel__btn detail-panel__btn--primary" onClick={handleApply}>
              Apply Changes
            </button>
            {canDelete && (
              <button
                className="detail-panel__btn detail-panel__btn--danger"
                title="Delete this node"
                onClick={() => {
                  onDelete(node.id)
                  onClose()
                }}
              >
                🗑 Delete node
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
