import { BookOpen, Gavel, Lightbulb, ScrollText, StickyNote, type LucideIcon } from 'lucide-react'
import { MEMORY_KIND_LABELS, type MemoryKind, type MemorySource } from '@sdlc/contracts'
import type { BadgeVariant } from '@/utils/status'

export const KIND_META: Record<MemoryKind, { label: string; icon: LucideIcon; variant: BadgeVariant; hint: string }> = {
  note: { label: MEMORY_KIND_LABELS.note, icon: StickyNote, variant: 'secondary', hint: 'Something worth knowing while working on this' },
  decision: { label: MEMORY_KIND_LABELS.decision, icon: Gavel, variant: 'default', hint: 'A choice that was made, and why' },
  convention: { label: MEMORY_KIND_LABELS.convention, icon: BookOpen, variant: 'outline', hint: 'How things are done here — follow it' },
  learning: { label: MEMORY_KIND_LABELS.learning, icon: Lightbulb, variant: 'warning', hint: 'Something that went wrong and how to avoid it' },
  summary: { label: MEMORY_KIND_LABELS.summary, icon: ScrollText, variant: 'success', hint: 'What was delivered' },
}

/** Kinds people write by hand (summaries are captured by the platform). */
export const WRITABLE_KINDS: MemoryKind[] = ['note', 'decision', 'convention', 'learning']

export const SOURCE_LABEL: Partial<Record<MemorySource, string>> = {
  run: 'From an agent run',
  story_done: 'Story roll-up',
  promotion: 'Promoted from a story',
  profile: 'Project profile',
}

/** The profile version a "Project profile vN" memory item mirrors (from its tags). */
export function profileVersionOf(item: { source: string; tags: string[] }): number | null {
  if (item.source !== 'profile') return null
  const tag = item.tags.find((t) => /^v\d+$/.test(t))
  return tag ? Number(tag.slice(1)) : null
}

/** The headline line of a profile's Markdown (`> …`). */
export function profileHeadline(content: string): string {
  return content.split('\n').find((l) => l.startsWith('> '))?.slice(2).trim() ?? ''
}
