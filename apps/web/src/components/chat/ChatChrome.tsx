'use client'

// Around the conversation: the history menu (recent chats, new chat, delete) and the greeting with suggestions
// shown before the first message.

import { History, MessageSquarePlus, Trash2 } from 'lucide-react'
import type { ChatAgentSummary, ChatThreadSummary } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { agentIcon, SUGGESTIONS } from './chatHelpers'

export function ThreadMenu({
  threads,
  agents,
  currentId,
  onOpen,
  onNew,
  onDelete,
}: {
  threads: ChatThreadSummary[]
  agents: ChatAgentSummary[]
  currentId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <UI.DropdownMenu>
        <UI.DropdownMenuTrigger asChild>
          <UI.Button variant="ghost" size="sm" className="gap-1.5" aria-label="Chat history">
            <History className="size-4" />
            <span className="hidden sm:inline">History</span>
          </UI.Button>
        </UI.DropdownMenuTrigger>
        <UI.DropdownMenuContent align="end" className="w-80">
          <UI.DropdownMenuLabel className="text-xs text-muted-foreground">Recent chats</UI.DropdownMenuLabel>
          {threads.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">No chats yet.</p> : null}
          <div className="max-h-96 overflow-y-auto">
            {threads.map((t) => {
              const agent = agents.find((a) => a.name === t.agent)
              const Icon = agentIcon(agent?.icon)
              return (
                <UI.DropdownMenuItem key={t.id} className={UI.cn('group cursor-pointer gap-2', t.id === currentId && 'bg-muted')} onSelect={() => onOpen(t.id)}>
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{t.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {agent?.label ?? t.agent}
                      {t.projectKey ? ` · ${t.projectKey}` : ''} · {UI.relativeTime(t.updatedAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      onDelete(t.id)
                    }}
                    aria-label={`Delete ${t.title}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </UI.DropdownMenuItem>
              )
            })}
          </div>
        </UI.DropdownMenuContent>
      </UI.DropdownMenu>
      <UI.Button variant="ghost" size="sm" className="gap-1.5" onClick={onNew} aria-label="New chat">
        <MessageSquarePlus className="size-4" />
        <span className="hidden sm:inline">New chat</span>
      </UI.Button>
    </div>
  )
}

export function ChatGreeting({ agent, onPick }: { agent: ChatAgentSummary | undefined; onPick: (text: string) => void }) {
  const Icon = agentIcon(agent?.icon)
  const name = agent?.name ?? 'default'
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon className="size-6" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
          {name === 'default' || !agent ? "Let me know when you're ready to begin." : `How can I help with ${agent.label.toLowerCase()}?`}
        </h1>
        <p className="max-w-lg text-sm text-muted-foreground">{agent?.description}</p>
      </div>
      <div className="flex max-w-2xl flex-wrap justify-center gap-2">
        {(SUGGESTIONS[name] ?? SUGGESTIONS.default).map((s) => (
          <UI.Button key={s} variant="outline" size="sm" className="h-auto rounded-full px-3 py-1.5 text-xs font-normal whitespace-normal" onClick={() => onPick(s)}>
            {s}
          </UI.Button>
        ))}
      </div>
    </div>
  )
}
