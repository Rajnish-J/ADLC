'use client'

// One chat conversation: the AI SDK chat (streaming, tool approvals, answers to the assistant's questions), the
// server thread behind it (created on the first send), and the drafts the assistant is building.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import { CLIENT_RESOLVED_TOOLS, type ChatDraft, type ChatThreadSummary } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { CHAT_STREAM_PATH, createThread, getThread, listThreadDrafts } from '@/service/chat.service'
import type { ChatPreferences } from './useChatPreferences'

type Part = UIMessage['parts'][number] & { toolCallId?: string; state?: string }

const isToolPart = (p: Part) => p.type.startsWith('tool-')
const toolName = (p: Part) => p.type.slice('tool-'.length)
const DRAFT_TOOLS = ['update_draft', 'load_workflow_into_draft', 'load_agent_into_draft', 'load_skill_into_draft']

/**
 * Continue automatically only when the user has answered something the assistant is waiting on: approvals,
 * or the cards the client resolves (questions, hand-offs). Never just because server tools finished — that
 * could loop.
 */
function shouldContinue({ messages }: { messages: UIMessage[] }): boolean {
  if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages })) return true
  const last = messages.at(-1)
  if (!last || last.role !== 'assistant') return false
  const parts = last.parts as Part[]
  const start = parts.findLastIndex((p) => p.type === 'step-start')
  const tools = parts.slice(start + 1).filter(isToolPart)
  return (
    tools.some((p) => (CLIENT_RESOLVED_TOOLS as readonly string[]).includes(toolName(p))) &&
    tools.every((p) => p.state === 'output-available' || p.state === 'output-error' || p.state === 'output-denied')
  )
}

export interface ChatSessionOptions {
  prefsRef: MutableRefObject<ChatPreferences>
  initialThreadId: string | null
  onThreadCreated: (thread: ChatThreadSummary) => void
  onReply?: (message: UIMessage) => void
}

export function useChatSession({ prefsRef, initialThreadId, onThreadCreated, onReply }: ChatSessionOptions) {
  const threadIdRef = useRef<string | null>(initialThreadId)
  const [threadId, setThreadId] = useState<string | null>(initialThreadId)
  const [drafts, setDrafts] = useState<ChatDraft[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const callbacks = useRef({ onThreadCreated, onReply })
  callbacks.current = { onThreadCreated, onReply }

  const refreshDrafts = useCallback(async () => {
    const id = threadIdRef.current
    if (!id) return
    try {
      setDrafts(await listThreadDrafts(id))
    } catch {
      // Drafts refresh on the next change; the conversation itself is unaffected.
    }
  }, [])

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: CHAT_STREAM_PATH,
        prepareSendMessagesRequest: async ({ messages }) => {
          const p = prefsRef.current
          let id = threadIdRef.current
          if (!id) {
            const thread = await createThread({ agent: p.agent, projectKey: p.projectKey, model: p.model })
            id = thread.id
            threadIdRef.current = id
            setThreadId(id)
            callbacks.current.onThreadCreated(thread)
          }
          return {
            body: {
              threadId: id,
              message: messages.at(-1),
              agent: p.agent,
              projectKey: p.projectKey,
              model: p.model,
              toolMode: p.toolMode,
              disabledTools: p.disabledTools[p.agent] ?? [],
            },
          }
        },
      }),
    [prefsRef],
  )

  const chat = useChat<UIMessage>({
    id: 'sdlc-chat',
    transport,
    experimental_throttle: 50,
    sendAutomaticallyWhen: shouldContinue,
    onFinish: ({ message }) => {
      void refreshDrafts()
      callbacks.current.onReply?.(message)
    },
  })
  const { setMessages, stop } = chat

  // The draft tools ran → the stepper and Review screen should show the new version without waiting for the end.
  const draftSignature = useMemo(
    () =>
      chat.messages
        .flatMap((m) => m.parts as Part[])
        .filter((p) => isToolPart(p) && DRAFT_TOOLS.includes(toolName(p)) && p.state === 'output-available')
        .map((p) => p.toolCallId)
        .join(','),
    [chat.messages],
  )
  useEffect(() => {
    if (draftSignature) void refreshDrafts()
  }, [draftSignature, refreshDrafts])

  const openThread = useCallback(
    async (id: string): Promise<ChatThreadSummary> => {
      setLoadingThread(true)
      try {
        await stop()
        const detail = await getThread(id)
        threadIdRef.current = id
        setThreadId(id)
        setMessages(detail.messages as unknown as UIMessage[])
        setDrafts(detail.drafts)
        return detail.thread
      } finally {
        setLoadingThread(false)
      }
    },
    [setMessages, stop],
  )

  /** Re-read the stored history (e.g. after a draft was submitted, which adds a note to the thread). */
  const reloadMessages = useCallback(async () => {
    const id = threadIdRef.current
    if (!id) return
    const detail = await getThread(id)
    setMessages(detail.messages as unknown as UIMessage[])
    setDrafts(detail.drafts)
  }, [setMessages])

  const newChat = useCallback(async () => {
    await stop()
    threadIdRef.current = null
    setThreadId(null)
    setMessages([])
    setDrafts([])
  }, [setMessages, stop])

  const error = chat.error ? (chat.error instanceof AppError ? chat.error : new AppError(readableError(chat.error))) : null

  return { ...chat, error, threadId, drafts, loadingThread, openThread, newChat, refreshDrafts, reloadMessages }
}

/** The transport reports a failed request with the raw response text — show the API's message when it has one. */
function readableError(err: Error): string {
  try {
    const parsed = JSON.parse(err.message) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // Not JSON.
  }
  return err.message || 'The assistant could not answer.'
}
