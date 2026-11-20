'use client'

// One message. The user's in a bubble; the assistant's as markdown, interleaved with its tool calls in the order
// they happened — lookups as compact rows, changes as Approve / Reject cards, questions as an answerable card.

import { useState } from 'react'
import { Brain, Check, ChevronRight, Copy } from 'lucide-react'
import type { UIMessage } from 'ai'
import {
  ASK_USER_TOOL,
  DRAFT_SUBMITTED_PART,
  HANDOFF_TOOL,
  type AskUserInput,
  type AskUserOutput,
  type ChatAgentSummary,
  type DraftSubmittedData,
  type HandoffInput,
} from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { Markdown } from '@/components/common/markdown'
import AskUserCard from './AskUserCard'
import { humanizeTool, isToolPart, messageText, toolNameOf, type ToolPart } from './chatHelpers'
import { ApprovalCard, DraftSubmittedCard, DraftUpdateRow, HandoffCard, ToolRow } from './ToolCards'

const DRAFT_TOOLS = new Set(['update_draft', 'load_workflow_into_draft', 'load_agent_into_draft', 'load_skill_into_draft'])

export interface MessageHandlers {
  onAnswer: (toolCallId: string, output: AskUserOutput) => void
  onDecide: (approvalId: string, approved: boolean, reason?: string) => void
  onHandoff: (toolCallId: string, input: HandoffInput) => void
  onReview: () => void
}

interface Props extends MessageHandlers {
  message: UIMessage
  /** The newest message, with no turn running — the only one whose cards can still be answered. */
  interactive: boolean
  toolLabels: Map<string, string>
  agents: ChatAgentSummary[]
  draftNoun: string
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <UI.Collapsible open={open} onOpenChange={setOpen}>
      <UI.CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Brain className="size-3.5" />
        Thinking
        <ChevronRight className={UI.cn('size-3 transition-transform', open && 'rotate-90')} />
      </UI.CollapsibleTrigger>
      <UI.CollapsibleContent>
        <p className="mt-1 border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{text}</p>
      </UI.CollapsibleContent>
    </UI.Collapsible>
  )
}

function ToolPartView({ part, props }: { part: ToolPart; props: Props }) {
  const name = toolNameOf(part)
  const label = props.toolLabels.get(name) ?? humanizeTool(name)
  if (name === ASK_USER_TOOL) {
    return (
      <AskUserCard
        input={part.input as AskUserInput | undefined}
        output={part.state === 'output-available' ? (part.output as AskUserOutput) : undefined}
        active={props.interactive && part.state === 'input-available'}
        onAnswer={(output) => props.onAnswer(part.toolCallId, output)}
      />
    )
  }
  if (name === HANDOFF_TOOL) {
    return (
      <HandoffCard
        input={part.input as HandoffInput | undefined}
        agents={props.agents}
        done={part.state === 'output-available'}
        active={props.interactive && part.state === 'input-available'}
        onAccept={() => props.onHandoff(part.toolCallId, part.input as HandoffInput)}
      />
    )
  }
  if (DRAFT_TOOLS.has(name)) return <DraftUpdateRow part={part} noun={props.draftNoun} onReview={props.onReview} />
  if (part.state === 'approval-requested' && part.approval) {
    const approvalId = part.approval.id
    return <ApprovalCard part={part} label={label} active={props.interactive} onDecide={(ok, reason) => props.onDecide(approvalId, ok, reason)} />
  }
  return <ToolRow part={part} label={label} />
}

export default function ChatMessage(props: Props) {
  const { message } = props
  const [copied, setCopied] = useState(false)

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">{messageText(message)}</div>
      </div>
    )
  }

  const text = messageText(message)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked — nothing to do.
    }
  }

  return (
    <div className="group/message flex flex-col gap-2.5">
      {message.parts.map((part, i) => {
        if (part.type === 'text') return part.text ? <Markdown key={i} source={part.text} className="text-sm" /> : null
        if (part.type === 'reasoning') return <Reasoning key={i} text={part.text} />
        if (part.type === DRAFT_SUBMITTED_PART) return <DraftSubmittedCard key={i} data={(part as unknown as { data: DraftSubmittedData }).data} />
        if (isToolPart(part)) return <ToolPartView key={part.toolCallId ?? i} part={part} props={props} />
        return null
      })}
      {text ? (
        <div className="flex opacity-0 transition-opacity group-hover/message:opacity-100">
          <UI.Button variant="ghost" size="icon-xs" onClick={copy} aria-label="Copy answer">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </UI.Button>
        </div>
      ) : null}
    </div>
  )
}
