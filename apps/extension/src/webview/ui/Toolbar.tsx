// Builder toolbar: node palette (Add Node ▼), Auto-layout, Save, and read-only banner.

import type { JSX } from 'react'
import type { PlatformWorkflowLink } from '../messages'

interface Props {
  isReadOnly: boolean
  workflowName: string
  onAutoLayout: () => void
  onSave: () => void
  onDuplicate: () => void
  onStart: () => void
  onNew: () => void
  onDelete: () => void
  canDelete: boolean
  activeTab: 'canvas' | 'yaml' | 'code' | 'settings'
  onTabChange: (tab: 'canvas' | 'yaml' | 'code' | 'settings') => void
  /** The project workflow this one corresponds to: its agent mapping is edited there. */
  platformLink?: PlatformWorkflowLink
  onOpenPlatform?: () => void
}

export function Toolbar({
  isReadOnly,
  workflowName,
  onAutoLayout,
  onSave,
  onDuplicate,
  onStart,
  onNew,
  onDelete,
  canDelete,
  activeTab,
  onTabChange,
  platformLink,
  onOpenPlatform,
}: Props): JSX.Element {
  return (
    <div className="toolbar">
      {/* Workflow name */}
      <span className="toolbar__name">{workflowName}</span>

      {/* View tabs */}
      <div className="toolbar__tabs">
        {(['canvas', 'yaml', 'code', 'settings'] as const).map((tab) => (
          <button
            key={tab}
            className={`toolbar__tab ${activeTab === tab ? 'toolbar__tab--active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            {tab === 'canvas' ? 'Visualizer' : tab === 'yaml' ? 'YAML' : tab === 'code' ? 'Code' : '⚙ Settings'}
          </button>
        ))}
      </div>

      <div className="toolbar__spacer" />

      <button className="toolbar__btn" onClick={onNew} title="Create a new workflow">
        ✚ New
      </button>

      {isReadOnly ? (
        <div className="toolbar__readonly-banner">
          🔒 Read-only — <button className="toolbar__link-btn" onClick={onDuplicate}>Duplicate to edit</button>
        </div>
      ) : (
        <>
          <button className="toolbar__btn" onClick={onAutoLayout} title="Auto-layout using Dagre">
            ↻ Auto-layout
          </button>

          <button className="toolbar__btn toolbar__btn--primary" onClick={onSave}>
            💾 Save
          </button>

          {canDelete && (
            <button className="toolbar__btn toolbar__btn--danger" onClick={onDelete} title="Delete this workflow">
              🗑 Delete Workflow
            </button>
          )}
        </>
      )}

      {platformLink && onOpenPlatform ? (
        <button
          className="toolbar__btn"
          onClick={onOpenPlatform}
          title={`Which agent runs each step is set on the ${platformLink.projectKey} project workflow "${platformLink.name}"`}
        >
          ⚙ Agent mapping ({platformLink.projectKey})
        </button>
      ) : null}

      <button
        className="toolbar__btn toolbar__btn--primary"
        onClick={onStart}
        title="Run this workflow in your selected harness (Copilot, Claude Code, Codex…) — sign in to the SDLC platform first"
      >
        ▶ Start
      </button>
    </div>
  )
}
