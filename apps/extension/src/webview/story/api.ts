// The Story panel webview's typed handle to the extension host, plus small display helpers. Only type imports
// from @sdlc/contracts, so the bundle carries no schema/runtime code.

import type { MemoryKind, StoryPriority, StoryRunStatus, StoryStatus } from '@sdlc/contracts'
import type { HostToStory, StoryToHost } from '../../platform/storyPanel/storyPanelMessages'

interface VsCodeApi {
  postMessage(message: StoryToHost): void
}

declare function acquireVsCodeApi(): VsCodeApi

const api = acquireVsCodeApi()

export function send(message: StoryToHost): void {
  api.postMessage(message)
}

export function onHostMessage(handler: (msg: HostToStory) => void): () => void {
  const listener = (ev: MessageEvent<HostToStory>) => handler(ev.data)
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

export const STATUS_LABEL: Record<StoryStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
}

// Kept here rather than imported, so the webview bundle carries no @sdlc/contracts runtime code.
export const PRIORITIES: StoryPriority[] = ['critical', 'high', 'medium', 'low']

export const PRIORITY_LABEL: Record<StoryPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const RUN_LABEL: Record<StoryRunStatus, string> = {
  requested: 'Requested',
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

export const KIND_LABEL: Record<MemoryKind, string> = {
  note: 'Note',
  decision: 'Decision',
  convention: 'Convention',
  learning: 'Learning',
  summary: 'Summary',
}

export const MEMORY_KINDS: MemoryKind[] = ['note', 'decision', 'convention', 'learning']

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.round(diff / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(iso).toLocaleDateString()
}

export function exactTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

export function duration(from: string, to: string | null): string {
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}
