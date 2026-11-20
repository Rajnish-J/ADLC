// Phase 4 (LangGraph) — click-to-expand introspection card for a canvas node. Shows two things:
//   • static agent identity — name, source, model, description, and the manifest file it's defined
//     in (openable via revealNode) — available regardless of run state.
//   • live run activity — the agent's current streamed "thought" and a running token estimate,
//     sourced from `RunStep.activity` (src/runtime/port.ts), which only the LangGraph runtime
//     populates (src/runtime/langgraph/langGraphRuntime.ts) — absent for MockWorkflowRuntime runs,
//     in which case the card explains that instead of showing nothing.

import type { JSX } from 'react'
import type { NodeOverlay } from '../../runtime/canvas/specToFlow'
import type { AgentSummary } from '../messages'
import { vscode } from './vscodeApi'

interface Props {
  nodeId: string
  label: string
  overlay: NodeOverlay | undefined
  agent: AgentSummary | undefined
  onClose: () => void
}

export function NodeIntrospectionCard({ nodeId, label, overlay, agent, onClose }: Props): JSX.Element {
  const activity = overlay?.activity
  const isRunning = overlay?.status === 'running'

  return (
    <div className="node-introspection-card" data-node-id={nodeId}>
      <div className="node-introspection-card__header">
        <span className="node-introspection-card__title">{label}</span>
        <button className="node-introspection-card__close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {agent ? (
        <div className="node-introspection-card__agent">
          <div className="node-introspection-card__agent-name">{agent.name}</div>
          <div className="node-introspection-card__agent-meta">
            {agent.sourceKind} · {agent.model ?? 'default model'}
          </div>
          {agent.description && (
            <div className="node-introspection-card__agent-desc">{agent.description}</div>
          )}
          {agent.sourcePath ? (
            <>
              <div className="node-introspection-card__agent-path" title={agent.sourcePath}>
                📄 {agent.sourcePath}
              </div>
              {agent.hasBundledScripts && (
                <div className="node-introspection-card__agent-note">
                  This agent bundles executable scripts alongside its manifest — open the source to audit them.
                </div>
              )}
              <button
                className="node-introspection-card__btn"
                title="Open this agent's manifest file"
                onClick={() => vscode.postMessage({ type: 'revealNode', nodeId })}
              >
                Open source
              </button>
            </>
          ) : (
            <div className="node-introspection-card__agent-note">No on-disk manifest (Azure Foundry agent).</div>
          )}
        </div>
      ) : (
        <div className="node-introspection-card__empty">No source manifest linked to this agent.</div>
      )}

      {!isRunning && (
        <div className="node-introspection-card__empty">
          Not currently running — live introspection only streams while this agent is active.
        </div>
      )}
      {isRunning && !activity?.thought && (
        <div className="node-introspection-card__empty">
          Waiting for the first streamed token… (live introspection requires the LangGraph runtime —
          set sdlcGovernance.runtime.engine to "langgraph" to enable it.)
        </div>
      )}
      {isRunning && activity?.thought && (
        <>
          <div className="node-introspection-card__meta">
            Live · ~{activity.liveTokensOut ?? 0} tokens streamed
          </div>
          <pre className="node-introspection-card__thought">{activity.thought}</pre>
        </>
      )}
    </div>
  )
}
