// Small chat helpers shared by the components: assistant icons, links to what a draft created, tool labels and
// the context-usage figure.

import { Bot, Brain, Compass, FolderKanban, GitBranch, ListTodo, Play, Puzzle, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import type { UIMessage } from 'ai'
import type { ChatMessageMetadata, DraftRef } from '@sdlc/contracts'

const ICONS: Record<string, LucideIcon> = { Sparkles, Workflow, FolderKanban, Bot, Puzzle, ListTodo, Brain, Play, Compass, GitBranch }

export function agentIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Sparkles
}

/** Where to open what a submitted draft created or changed. */
export function draftHref(ref: DraftRef): string {
  const base = `/projects/${ref.projectKey}`
  switch (ref.type) {
    case 'workflow':
      return `${base}/workflow`
    case 'project':
      return base
    case 'agent':
      return `${base}/${ref.kind === 'skill' ? 'skills' : 'agents'}/${encodeURIComponent(ref.slug)}`
    case 'stories':
      return ref.numbers.length === 1 ? `${base}/stories/${ref.numbers[0]}` : base
  }
}

/** "set_step_agent" → "Set step agent" when the tool list hasn't loaded a label. */
export function humanizeTool(name: string): string {
  const s = name.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Tokens in the context window after the latest answer (input of the last step + its output). */
export function contextTokens(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = (messages[i].metadata as ChatMessageMetadata | undefined)?.usage
    if (usage) return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  }
  return 0
}

/** The plain text of a message (for read-aloud and copying). */
export function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

export type ToolPart = UIMessage['parts'][number] & {
  type: `tool-${string}`
  toolCallId: string
  state: 'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' | 'output-denied'
  input?: unknown
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean; reason?: string }
}

export const isToolPart = (p: UIMessage['parts'][number]): p is ToolPart => p.type.startsWith('tool-')
export const toolNameOf = (p: ToolPart): string => p.type.slice('tool-'.length)

/** Suggestions on the empty screen, per assistant. */
export const SUGGESTIONS: Record<string, string[]> = {
  default: ['What needs attention across my projects?', 'Which workflows does this project have?', 'Summarise my stories'],
  workflows: ['Create a hotfix workflow with a security review', 'Add a design review step to our default workflow', 'Which agent runs each step?'],
  projects: ['Set up a new project for the mobile app', 'Who is on this project, and with what roles?', 'Add Devi as a developer'],
  agents: ['Create a security reviewer agent for API changes', 'Make a customised copy of the planner', 'Which agents are enabled here?'],
  skills: ['Write a skill for our database migrations', 'Attach a skill to the implement step', 'What skills do we have?'],
  stories: ['Turn "CSV export of invoices" into stories', 'Break PAY-2 into tasks', 'What is in progress right now?'],
  memory: ['Record that we store all timestamps in UTC', 'What conventions has the project agreed?', 'Review proposed memory'],
  runs: ['Start my story in VS Code', 'Why did the last run fail?', 'Which runs are waiting for approval?'],
  portfolio: ['What needs attention this week?', 'Which projects have overdue stories?', 'Who is overloaded?'],
  repos: ['Is our repository in sync?', 'Link github.com/acme/payments to this project', 'Which Git connections do we have?'],
}
