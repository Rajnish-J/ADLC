// Phase 5A — map a node's live execution status to presentation. Keeps the visual vocabulary in one
// place: CSS modifier class (border/glow) + a short status glyph. Colors come from VS Code theme
// tokens defined in styles.css so the canvas matches light/dark/high-contrast themes.

import type { RunStepStatus } from '../../runtime/port'

/** CSS modifier appended to `.gov-node` for the given status (empty when not yet executed). */
export function statusClass(status?: RunStepStatus): string {
  return status ? `gov-node--${status}` : ''
}

/** A compact glyph shown in the node's status corner. */
export function statusGlyph(status?: RunStepStatus): string {
  switch (status) {
    case 'running':
      return '◐'
    case 'succeeded':
      return '✓'
    case 'failed':
      return '✕'
    case 'blocked':
      return '⛔'
    case 'skipped':
      return '–'
    default:
      return ''
  }
}
