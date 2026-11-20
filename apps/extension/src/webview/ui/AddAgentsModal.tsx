// Modal for picking an agent to attach to an AGENT node.
// Groups discovered agents by sourceKind (tab per source).

import type { JSX } from 'react'
import { useState } from 'react'
import type { AgentSummary } from '../messages'

interface Props {
  agents: AgentSummary[]
  onSelect: (agent: AgentSummary) => void
  onClose: () => void
}

export function AddAgentsModal({ agents, onSelect, onClose }: Props): JSX.Element {
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<string>('all')

  const sourceKinds = Array.from(new Set(agents.map((a) => a.sourceKind)))
  const tabs = ['all', ...sourceKinds]

  const filtered = agents.filter((a) => {
    const matchesSearch =
      !search ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase())
    const matchesTab = activeTab === 'all' || a.sourceKind === activeTab
    return matchesSearch && matchesTab
  })

  const sourceLabel = (kind: string): string => {
    const labels: Record<string, string> = {
      all: 'All',
      'claude-agent': 'Claude',
      'claude-skill': 'Skills',
      'agents-md': 'agents.md',
      'agent-yaml': 'YAML',
      'copilot-instructions': 'Copilot',
      'cursor-rules': 'Cursor',
      azure_foundry: 'Azure Foundry',
      discovered: 'Workspace',
    }
    return labels[kind] ?? kind
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">Add Agent</span>
          <button className="modal__close" onClick={onClose}>✕</button>
        </div>

        <input
          className="modal__search"
          placeholder="Search agents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        <div className="modal__tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`modal__tab ${activeTab === tab ? 'modal__tab--active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {sourceLabel(tab)}
            </button>
          ))}
        </div>

        <div className="modal__list">
          {filtered.length === 0 ? (
            <div className="modal__empty">
              {agents.length === 0
                ? 'No agents discovered yet. Run the "Discover Agents" command first.'
                : 'No agents match your search.'}
            </div>
          ) : (
            filtered.map((agent) => (
              <button
                key={agent.id}
                className="modal__agent-row"
                onClick={() => onSelect(agent)}
              >
                <div className="modal__agent-name">{agent.name}</div>
                <div className="modal__agent-meta">
                  {sourceLabel(agent.sourceKind)}{agent.model ? ` · ${agent.model}` : ''}
                </div>
                {agent.description && (
                  <div className="modal__agent-desc">{agent.description}</div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
