// Modal for creating a new workflow by selecting multiple agents (discovered + Foundry).
// Mirrors AddAgentsModal's layout (search + source tabs) but supports multi-select via checkboxes
// and a workflow-name input. On confirm it returns the name + chosen agents; the caller builds a
// sequential spec (see specFromAgents) and persists it.

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { AgentSummary } from '../messages'
import type { WorkflowTrigger } from './builderUtils'
import { vscode } from './vscodeApi'

interface Props {
  agents: AgentSummary[]
  onCreate: (name: string, selected: AgentSummary[], trigger: WorkflowTrigger) => void
  onClose: () => void
}

const SOURCE_LABELS: Record<string, string> = {
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

export function CreateWorkflowModal({ agents, onCreate, onClose }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<string>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [triggerType, setTriggerType] = useState<'issue' | 'manual'>('issue')

  // Discovery's background scan may still be running when this modal opens (e.g. right after
  // startup) — ask for a fresh agent list once on mount so it doesn't stay stuck empty.
  useEffect(() => {
    vscode.postMessage({ type: 'requestAgents' })
  }, [])

  const sourceKinds = Array.from(new Set(agents.map((a) => a.sourceKind)))
  const tabs = ['all', ...sourceKinds]
  const sourceLabel = (kind: string): string => SOURCE_LABELS[kind] ?? kind

  const filtered = agents.filter((a) => {
    const matchesSearch =
      !search ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase())
    const matchesTab = activeTab === 'all' || a.sourceKind === activeTab
    return matchesSearch && matchesTab
  })

  const toggle = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Whether every agent in the current search/tab view is already selected.
  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id))

  // Select (or clear) all agents matching the current search + tab in one click.
  const toggleSelectAll = (): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        for (const a of filtered) next.delete(a.id)
      } else {
        for (const a of filtered) next.add(a.id)
      }
      return next
    })
  }

  const canCreate = name.trim().length > 0 && selectedIds.size > 0

  const handleCreate = (): void => {
    if (!canCreate) return
    // Preserve the agents list order for a stable sequential workflow.
    const selected = agents.filter((a) => selectedIds.has(a.id))
    onCreate(name.trim(), selected, { type: triggerType })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">New Workflow</span>
          <button className="modal__close" onClick={onClose}>✕</button>
        </div>

        <input
          className="modal__search"
          placeholder="Workflow name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <input
          className="modal__search"
          placeholder="Search agents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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

        <div className="modal__selectall-row">
          <button
            className="modal__selectall-btn"
            onClick={toggleSelectAll}
            disabled={filtered.length === 0}
            title="Select every agent matching the current search"
          >
            {allFilteredSelected ? '☑ Deselect all' : '☐ Select all'}
            {search || activeTab !== 'all' ? ` (${filtered.length})` : ''}
          </button>
          <button
            className="modal__selectall-btn"
            onClick={() => vscode.postMessage({ type: 'requestAgents' })}
            title="Re-scan for newly added agent manifests"
          >
            🔄 Refresh
          </button>
        </div>

        <div className="modal__list">
          {filtered.length === 0 ? (
            <div className="modal__empty">
              {agents.length === 0
                ? 'No agents discovered yet. Open a workspace folder with agent manifests ' +
                  '(.claude/agents, AGENTS.md, …), or run the "Discover Agents" command, then Refresh.'
                : 'No agents match your search.'}
            </div>
          ) : (
            filtered.map((agent) => {
              const checked = selectedIds.has(agent.id)
              return (
                <button
                  key={agent.id}
                  className={`modal__agent-row ${checked ? 'modal__agent-row--selected' : ''}`}
                  onClick={() => toggle(agent.id)}
                >
                  <div className="modal__agent-name">
                    <span className="modal__check">{checked ? '☑' : '☐'}</span> {agent.name}
                  </div>
                  <div className="modal__agent-meta">
                    {sourceLabel(agent.sourceKind)}{agent.model ? ` · ${agent.model}` : ''}
                  </div>
                  {agent.description && (
                    <div className="modal__agent-desc">{agent.description}</div>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="modal__footer">
          <span className="modal__count">{selectedIds.size} selected</span>
          <select
            className="detail-panel__select detail-panel__btn--sm"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as 'issue' | 'manual')}
            title="What seeds the run when you click Start"
          >
            <option value="issue">Start: Azure DevOps user story</option>
            <option value="manual">Start: Manual task</option>
          </select>
          <button
            className="detail-panel__btn detail-panel__btn--primary detail-panel__btn--sm"
            disabled={!canCreate}
            onClick={handleCreate}
          >
            Create workflow
          </button>
        </div>
      </div>
    </div>
  )
}
