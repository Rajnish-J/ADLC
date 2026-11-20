'use client'

// The Chat page: pick an assistant (Default or a specialist), a project and a model, and talk. Specialists that
// build something keep a draft — the stepper above the composer opens it for Review & submit. Every change the
// assistant wants to make waits for Approve / Reject in the conversation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
// import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react' — voice controls are commented out below
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/chat.imports'


export default function ChatContainer() {
  const router = useRouter()
  const params = useSearchParams()
  const { prefs, update } = C.useChatPreferences({ agent: params.get('agent') ?? undefined, projectKey: params.get('project') ?? undefined })
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const config = C.useApiResource(C.getChatConfig, [])
  const agents = C.useApiResource(C.listChatAgents, [])
  const projects = C.useApiResource(C.listProjects, [], (e) => e.type === 'project.changed')
  const threads = C.useApiResource(C.listThreads, [])
  const tools = C.useApiResource(() => C.listChatTools(prefs.agent, prefs.projectKey, prefs.toolMode), [prefs.agent, prefs.projectKey, prefs.toolMode])

  // const voice = C.useReadAloud()
  const session = C.useChatSession({
    prefsRef,
    initialThreadId: null,
    onThreadCreated: (t) => {
      void threads.reload()
      router.replace(`/chat?thread=${t.id}`, { scroll: false })
    },
    onReply: (m) => {
      // if (prefsRef.current.readAloud) voice.speak(C.messageText(m))
    },
  })

  const [input, setInput] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  // const dictation = C.useDictation((text) => setInput((v) => (v ? `${v} ${text}` : text)))

  const agentList = agents.data ?? []
  const agent = agentList.find((a) => a.name === prefs.agent) ?? agentList[0]
  const busy = session.status === 'submitted' || session.status === 'streaming'
  const enabled = config.data?.enabled ?? false
  const models = config.data?.models ?? []
  const model = models.find((m) => m.id === prefs.model) ?? models.find((m) => m.id === config.data?.defaultModel) ?? models[0]
  const disabledTools = prefs.disabledTools[prefs.agent] ?? []
  const toolLabels = useMemo(() => new Map((tools.data ?? []).map((t) => [t.name, t.label])), [tools.data])

  // Open the thread named in the URL once.
  const opened = useRef(false)
  useEffect(() => {
    const id = params.get('thread')
    if (opened.current || !id) return
    opened.current = true
    session
      .openThread(id)
      .then((t) => update({ agent: t.agent, projectKey: t.projectKey }))
      .catch(() => router.replace('/chat'))
  }, [params, session, update, router])

  // The draft this assistant is building: the open one, else the latest.
  const draft = useMemo(() => {
    if (!agent?.draft) return null
    const mine = session.drafts.filter((d) => d.kind === agent.draft)
    return mine.find((d) => d.status === 'open') ?? mine.at(-1) ?? null
  }, [agent?.draft, session.drafts])

  // Keep the newest message in view while the user is at the bottom.
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [session.messages, session.status])

  const send = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t || !enabled) return
      stick.current = true
      void session.sendMessage({ text: t })
      setInput('')
    },
    [enabled, session],
  )

  const openThread = async (id: string) => {
    try {
      const t = await session.openThread(id)
      update({ agent: t.agent, projectKey: t.projectKey })
      router.replace(`/chat?thread=${id}`, { scroll: false })
    } catch {
      UI.toast.error('Could not open that chat.')
    }
  }
  const newChat = async () => {
    await session.newChat()
    router.replace('/chat', { scroll: false })
  }
  const removeThread = async (id: string) => {
    await C.deleteThread(id).catch(() => undefined)
    if (id === session.threadId) await newChat()
    void threads.reload()
  }

  const handlers = {
    onAnswer: (toolCallId: string, output: C.AskUserOutput) => void session.addToolOutput({ tool: 'ask_user', toolCallId, output }),
    onDecide: (id: string, approved: boolean, reason?: string) => void session.addToolApprovalResponse({ id, approved, reason }),
    onHandoff: (toolCallId: string, handoff: C.HandoffInput) => {
      // Switch first, so the automatic follow-up goes to the specialist.
      prefsRef.current = { ...prefsRef.current, agent: handoff.agent }
      update({ agent: handoff.agent })
      void session.addToolOutput({ tool: 'handoff', toolCallId, output: { accepted: true } })
    },
    onReview: () => setReviewOpen(true),
  }

  const needsProject = agent?.scope === 'project' && !prefs.projectKey
  const composer = (
    <C.PromptInput
      value={input}
      onChange={setInput}
      onSubmit={() => send(input)}
      onStop={() => void session.stop()}
      busy={busy}
      disabled={!enabled || session.loadingThread}
      placeholder={enabled ? (needsProject ? 'Pick a project, then describe what you need…' : (agent?.placeholder ?? 'Ask anything…')) : 'Chat is not configured'}
      left={
        <>
          <C.SelectAgent agents={agentList} value={prefs.agent} onChange={(name) => update({ agent: name })} />
          <C.ToolModeDropdown value={prefs.toolMode} onChange={(toolMode) => update({ toolMode })} />
          <C.ToolsPill
            tools={tools.data ?? []}
            disabled={disabledTools}
            onToggle={(name, on) =>
              update({ disabledTools: { ...prefs.disabledTools, [prefs.agent]: on ? disabledTools.filter((t) => t !== name) : [...disabledTools, name] } })
            }
          />
          <C.ProjectChip projects={projects.data ?? []} value={prefs.projectKey} onChange={(projectKey) => update({ projectKey })} required={agent?.scope === 'project'} />
        </>
      }
      right={
        <>
          {/* Mic (dictation) and read-aloud are commented out until they work.
          {dictation.supported ? (
            <UI.Button type="button" variant="ghost" size="icon-sm" className="rounded-full" onClick={dictation.toggle} aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}>
              {dictation.listening ? <MicOff className="size-4 text-destructive" /> : <Mic className="size-4" />}
            </UI.Button>
          ) : null}
          {voice.supported ? (
            <UI.Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              onClick={() => {
                if (prefs.readAloud) voice.cancel()
                update({ readAloud: !prefs.readAloud })
              }}
              aria-label={prefs.readAloud ? 'Stop reading answers aloud' : 'Read answers aloud'}
            >
              {prefs.readAloud ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </UI.Button>
          ) : null}
          */}
          {model ? <C.ContextUsageRing used={C.contextTokens(session.messages)} total={model.contextWindow} /> : null}
          <C.SelectModel models={models} value={model?.id ?? null} onChange={(id) => update({ model: id })} />
        </>
      }
    />
  )

  const stepper = agent?.draft ? (
    <C.DraftStepper
      kind={agent.draft}
      icon={agent.icon}
      draft={draft}
      configured={agent.scope === 'org' || Boolean(prefs.projectKey)}
      busy={busy}
      onReview={() => setReviewOpen(true)}
    />
  ) : null

  const notConfigured =
    config.data && !config.data.enabled ? (
      <UI.Alert>
        <UI.AlertTitle>Chat is not configured</UI.AlertTitle>
        <UI.AlertDescription>{config.data.reason}</UI.AlertDescription>
      </UI.Alert>
    ) : null

  const empty = session.messages.length === 0 && !session.loadingThread
  const last = session.messages.at(-1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-2">
        <C.ThreadMenu threads={threads.data ?? []} agents={agentList} currentId={session.threadId} onOpen={(id) => void openThread(id)} onNew={() => void newChat()} onDelete={(id) => void removeThread(id)} />
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-4 pb-10">
          <C.ChatGreeting agent={agent} onPick={send} />
          <div className="flex w-full max-w-3xl flex-col gap-3">
            {notConfigured}
            {stepper}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }}
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
              {session.loadingThread ? <UI.Skeleton className="h-24 w-full" /> : null}
              {session.messages.map((m) => (
                <C.ChatMessage
                  key={m.id}
                  message={m}
                  interactive={m === last && !busy}
                  toolLabels={toolLabels}
                  agents={agentList}
                  draftNoun={agent?.draft ?? 'draft'}
                  {...handlers}
                />
              ))}
              {session.status === 'submitted' ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <UI.Spinner className="size-3.5" />
                  Thinking…
                </span>
              ) : null}
            </div>
          </div>
          <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4">
            {session.error ? (
              <UI.Alert variant="destructive">
                <UI.AlertTitle>The assistant stopped</UI.AlertTitle>
                <UI.AlertDescription className="flex items-center justify-between gap-2">
                  <span>{session.error.message}</span>
                  <UI.Button size="xs" variant="outline" onClick={() => session.clearError()}>
                    Dismiss
                  </UI.Button>
                </UI.AlertDescription>
              </UI.Alert>
            ) : null}
            {notConfigured}
            {stepper}
            {composer}
            <p className="text-center text-[11px] text-muted-foreground">Assistants can make mistakes. Every change waits for your approval.</p>
          </div>
        </>
      )}

      <C.DraftReviewSheet
        draft={draft}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onChanged={(d) => {
          void session.refreshDrafts()
          if (d.status === 'submitted') void session.reloadMessages()
        }}
      />
    </div>
  )
}
