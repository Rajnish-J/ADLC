// The Chat panel's UI — the same assistants, drafts and approvals as the web app's /chat, in VS Code's look.
// Choices (assistant, project, model, tool mode) are kept in the webview state, so they survive reloads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai'
import {
  CHAT_TOOL_MODE_LABELS,
  CHAT_TOOL_MODES,
  DRAFT_KIND_LABELS,
  type AskUserOutput,
  type ChatAgentSummary,
  type ChatConfig,
  type ChatDraft,
  type ChatThreadDetail,
  type ChatThreadSummary,
  type ChatToolInfo,
  type ChatToolMode,
  type HandoffInput,
} from '@sdlc/contracts'
import { api, HostChatTransport, loadState, onHost, post, saveState } from './bridge'
import DraftReview, { type Options } from './DraftReview'
import Message from './Message'

interface Prefs {
  agent: string
  projectKey: string | null
  model: string | null
  toolMode: ChatToolMode
  disabled: Record<string, string[]>
}

type Part = { type: string; state?: string }
const CLIENT_TOOLS = ['tool-ask_user', 'tool-handoff']

/** Continue on its own only after the user answered something the assistant waits on (never after server tools). */
function shouldContinue({ messages }: { messages: UIMessage[] }): boolean {
  if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages })) return true
  const last = messages.at(-1)
  if (!last || last.role !== 'assistant') return false
  const parts = last.parts as Part[]
  let start = -1
  parts.forEach((p, i) => p.type === 'step-start' && (start = i))
  const tools = parts.slice(start + 1).filter((p) => p.type.startsWith('tool-'))
  return tools.some((p) => CLIENT_TOOLS.includes(p.type)) && tools.every((p) => ['output-available', 'output-error', 'output-denied'].includes(p.state ?? ''))
}

function contextTokens(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = (messages[i].metadata as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined)?.usage
    if (u) return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
  }
  return 0
}

function AgentPicker({ agents, value, onChange }: { agents: ChatAgentSummary[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const current = agents.find((a) => a.name === value)
  return (
    <div className="picker">
      <button type="button" className={`pill ${value !== 'default' ? 'accent' : ''}`} onClick={() => setOpen(!open)}>
        {current?.label ?? 'Default'} ▾
      </button>
      {open ? (
        <>
          <div className="click-away" onClick={() => setOpen(false)} />
          <div className="menu">
            {agents.map((a, i) => (
              <div key={a.name}>
                {i === 1 ? <div className="menu-label">Specialists</div> : null}
                <button
                  type="button"
                  className={`menu-item ${a.name === value ? 'on' : ''}`}
                  onClick={() => {
                    onChange(a.name)
                    setOpen(false)
                  }}
                >
                  <span className="menu-title">
                    {a.label}
                    {a.name === value ? ' ✓' : ''}
                  </span>
                  <span className="menu-desc">{a.description}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

function Stepper({ kind, draft, configured, busy, onReview }: { kind: keyof typeof DRAFT_KIND_LABELS; draft: ChatDraft | null; configured: boolean; busy: boolean; onReview: () => void }) {
  const tone = !draft ? 'idle' : draft.status === 'submitted' ? 'done' : draft.ready ? 'ready' : 'open'
  const current = !configured ? 0 : tone === 'ready' || tone === 'done' ? 2 : 1
  const label = { idle: 'Not started', open: draft?.openQuestions.length ? `${draft.openQuestions.length} open question(s)` : 'Draft saved', ready: 'Ready to review', done: 'Submitted' }[tone]
  return (
    <div className="stepper">
      <strong className="ellipsis">{draft?.targetLabel ? `Edit ${DRAFT_KIND_LABELS[kind].noun}: ${draft.targetLabel}` : DRAFT_KIND_LABELS[kind].title}</strong>
      <ol>
        {['Configure', 'Describe', 'Review'].map((s, i) => (
          <li key={s} className={i < current || tone === 'done' ? 'done' : i === current ? 'active' : ''}>
            <span className="dot">{i < current || tone === 'done' ? '✓' : i + 1}</span> {s}
          </li>
        ))}
      </ol>
      <button type="button" className={tone === 'ready' ? '' : 'secondary'} disabled={!draft || busy} onClick={onReview} title={label}>
        <span className={`tone ${tone}`} /> Review &amp; submit
      </button>
    </div>
  )
}

export default function ChatApp() {
  const [host, setHost] = useState<{ signedIn: boolean; userName: string | null } | null>(null)
  useEffect(() => {
    const off = onHost((m) => m.type === 'init' && setHost({ signedIn: m.signedIn, userName: m.userName }))
    post({ type: 'ready' })
    return off
  }, [])
  if (!host) return <div className="empty muted">Loading…</div>
  if (!host.signedIn) {
    return (
      <div className="empty">
        <p>Sign in to the SDLC platform to chat with its assistants.</p>
        <button type="button" onClick={() => post({ type: 'signIn' })}>
          Connect to the SDLC Platform
        </button>
      </div>
    )
  }
  return <Chat key={host.userName ?? 'me'} />
}

function Chat() {
  const saved = loadState<Prefs & { threadId: string | null }>()
  const [prefs, setPrefsState] = useState<Prefs>({
    agent: saved.agent ?? 'default',
    projectKey: saved.projectKey ?? null,
    model: saved.model ?? null,
    toolMode: saved.toolMode ?? 'auto',
    disabled: saved.disabled ?? {},
  })
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const threadIdRef = useRef<string | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const setPrefs = (patch: Partial<Prefs>) => {
    prefsRef.current = { ...prefsRef.current, ...patch }
    setPrefsState(prefsRef.current)
  }
  useEffect(() => saveState({ ...prefs, threadId }), [prefs, threadId])

  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [agents, setAgents] = useState<ChatAgentSummary[]>([])
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([])
  const [threads, setThreads] = useState<ChatThreadSummary[]>([])
  const [tools, setTools] = useState<ChatToolInfo[]>([])
  const [drafts, setDrafts] = useState<ChatDraft[]>([])
  const [options, setOptions] = useState<Options>({ agents: [], skills: [], connections: [] })
  const [input, setInput] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [showTools, setShowTools] = useState(false)

  const loadThreads = useCallback(() => void api<ChatThreadSummary[]>('GET', '/chat/threads').then(setThreads).catch(() => undefined), [])
  const refreshDrafts = useCallback(async () => {
    if (threadIdRef.current) setDrafts(await api<ChatDraft[]>('GET', `/chat/threads/${threadIdRef.current}/drafts`).catch(() => []))
  }, [])

  useEffect(() => {
    void api<ChatConfig>('GET', '/chat/config').then(setConfig).catch(() => undefined)
    void api<ChatAgentSummary[]>('GET', '/chat/agents').then(setAgents).catch(() => undefined)
    void api<{ key: string; name: string }[]>('GET', '/projects').then(setProjects).catch(() => undefined)
    loadThreads()
  }, [loadThreads])
  useEffect(() => {
    const q = new URLSearchParams({ agent: prefs.agent, mode: prefs.toolMode })
    if (prefs.projectKey) q.set('project', prefs.projectKey)
    void api<ChatToolInfo[]>('GET', `/chat/tools?${q}`).then(setTools).catch(() => setTools([]))
  }, [prefs.agent, prefs.projectKey, prefs.toolMode])
  useEffect(() => {
    if (!reviewing) return
    void (async () => {
      const list = prefs.projectKey ? await api<{ slug: string; name: string; kind: string; enabled: boolean; usable: boolean }[]>('GET', `/projects/${prefs.projectKey}/agents`).catch(() => []) : []
      const conns = await api<{ id: string; name: string; owner: string | null }[]>('GET', '/git-connections').catch(() => [])
      const usable = list.filter((a) => a.enabled && a.usable)
      setOptions({
        agents: usable.filter((a) => a.kind === 'agent').map((a) => ({ value: a.slug, label: `${a.name} (${a.slug})` })),
        skills: usable.filter((a) => a.kind === 'skill').map((a) => ({ value: a.slug, label: a.name })),
        connections: conns.map((c) => ({ value: c.id, label: c.owner ? `${c.name} — ${c.owner}` : c.name })),
      })
    })()
  }, [reviewing, prefs.projectKey])

  const transport = useMemo(
    () =>
      new HostChatTransport(async (messages) => {
        const p = prefsRef.current
        if (!threadIdRef.current) {
          const t = await api<ChatThreadSummary>('POST', '/chat/threads', { agent: p.agent, projectKey: p.projectKey, model: p.model })
          threadIdRef.current = t.id
          setThreadId(t.id)
          loadThreads()
        }
        return { threadId: threadIdRef.current, message: messages.at(-1), agent: p.agent, projectKey: p.projectKey, model: p.model, toolMode: p.toolMode, disabledTools: p.disabled[p.agent] ?? [] }
      }),
    [loadThreads],
  )
  const chat = useChat<UIMessage>({ id: 'vscode-chat', transport, experimental_throttle: 50, sendAutomaticallyWhen: shouldContinue, onFinish: () => void refreshDrafts() })
  const { messages, setMessages, status, stop } = chat
  const busy = status === 'submitted' || status === 'streaming'

  // Refresh the draft while the assistant is saving it, and when the platform reports changes.
  const draftCalls = messages.flatMap((m) => m.parts as Part[]).filter((p) => /^tool-(update_draft|load_\w+_into_draft)$/.test(p.type) && p.state === 'output-available').length
  useEffect(() => void refreshDrafts(), [draftCalls, refreshDrafts])
  useEffect(() => onHost((m) => m.type === 'platformEvent' && void refreshDrafts()), [refreshDrafts])

  const openThread = async (id: string) => {
    await stop()
    const detail = await api<ChatThreadDetail>('GET', `/chat/threads/${id}`)
    threadIdRef.current = id
    setThreadId(id)
    setMessages(detail.messages as unknown as UIMessage[])
    setDrafts(detail.drafts)
    setPrefs({ agent: detail.thread.agent, projectKey: detail.thread.projectKey })
  }
  const newChat = async () => {
    await stop()
    threadIdRef.current = null
    setThreadId(null)
    setMessages([])
    setDrafts([])
  }
  // Re-open the thread this panel showed last time (once, on mount).
  useEffect(() => {
    if (saved.threadId) void openThread(saved.threadId).catch(() => undefined)
  }, [])

  const agent = agents.find((a) => a.name === prefs.agent) ?? agents[0]
  const model = config?.models.find((m) => m.id === prefs.model) ?? config?.models.find((m) => m.id === config.defaultModel) ?? config?.models[0]
  const draft = agent?.draft ? (drafts.filter((d) => d.kind === agent.draft).find((d) => d.status === 'open') ?? drafts.filter((d) => d.kind === agent.draft).at(-1) ?? null) : null
  const labels = new Map(tools.map((t) => [t.name, t.label]))
  const disabled = prefs.disabled[prefs.agent] ?? []
  const activeTools = tools.filter((t) => t.available && !disabled.includes(t.name)).length
  const pct = model ? Math.min(100, Math.round((contextTokens(messages) / model.contextWindow) * 100)) : 0
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages, status])

  const send = () => {
    const text = input.trim()
    if (!text || busy || !config?.enabled) return
    void chat.sendMessage({ text })
    setInput('')
  }

  return (
    <div className="chat">
      <header className="bar">
        <select className="input thread-select" value={threadId ?? ''} onChange={(e) => (e.target.value ? void openThread(e.target.value) : void newChat())}>
          <option value="">New chat</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
              {t.projectKey ? ` · ${t.projectKey}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={() => void newChat()}>
          New chat
        </button>
      </header>

      <div className="messages" ref={scroller}>
        {messages.length === 0 ? (
          <div className="greeting">
            <h1>{!agent || agent.name === 'default' ? "Let me know when you're ready to begin." : `How can I help with ${agent.label.toLowerCase()}?`}</h1>
            <p className="muted">{agent?.description}</p>
          </div>
        ) : null}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            interactive={m === messages.at(-1) && !busy}
            labels={labels}
            agents={agents}
            onAnswer={(toolCallId, output: AskUserOutput) => void chat.addToolOutput({ tool: 'ask_user', toolCallId, output })}
            onDecide={(id, approved, reason) => void chat.addToolApprovalResponse({ id, approved, reason })}
            onHandoff={(toolCallId, h: HandoffInput) => {
              setPrefs({ agent: h.agent })
              void chat.addToolOutput({ tool: 'handoff', toolCallId, output: { accepted: true } })
            }}
            onReview={() => setReviewing(true)}
            onOpenRef={(ref) => post({ type: 'openRef', ref })}
          />
        ))}
        {status === 'submitted' ? <div className="muted">Thinking…</div> : null}
      </div>

      <footer className="dock">
        {chat.error ? (
          <div className="notice err">
            {chat.error.message} <button type="button" className="link" onClick={() => chat.clearError()}>Dismiss</button>
          </div>
        ) : null}
        {config && !config.enabled ? <div className="notice">{config.reason}</div> : null}
        {agent?.draft ? <Stepper kind={agent.draft} draft={draft} configured={agent.scope === 'org' || Boolean(prefs.projectKey)} busy={busy} onReview={() => setReviewing(true)} /> : null}
        <div className="composer">
          <textarea
            rows={2}
            value={input}
            placeholder={agent?.scope === 'project' && !prefs.projectKey ? 'Pick a project, then describe what you need…' : (agent?.placeholder ?? 'Ask anything…')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="toolbar">
            <AgentPicker agents={agents} value={prefs.agent} onChange={(a) => setPrefs({ agent: a })} />
            <select className="input pill-select" value={prefs.toolMode} onChange={(e) => setPrefs({ toolMode: e.target.value as ChatToolMode })} title={CHAT_TOOL_MODE_LABELS[prefs.toolMode].description}>
              {CHAT_TOOL_MODES.map((m) => (
                <option key={m} value={m}>
                  {CHAT_TOOL_MODE_LABELS[m].label}
                </option>
              ))}
            </select>
            <div className="picker">
              <button type="button" className="pill" onClick={() => setShowTools(!showTools)}>
                Tools {activeTools}
              </button>
              {showTools ? (
                <>
                  <div className="click-away" onClick={() => setShowTools(false)} />
                  <div className="menu tools-menu">
                    {tools.map((t) => (
                      <label key={t.name} className={`tool-option ${t.available ? '' : 'muted'}`} title={t.reason ?? ''}>
                        <input
                          type="checkbox"
                          checked={t.available && !disabled.includes(t.name)}
                          disabled={!t.available}
                          onChange={(e) => setPrefs({ disabled: { ...prefs.disabled, [prefs.agent]: e.target.checked ? disabled.filter((x) => x !== t.name) : [...disabled, t.name] } })}
                        />
                        {t.label} {t.access === 'write' ? <span className="badge">approval</span> : null}
                        {!t.available && t.reason ? <span className="small"> — {t.reason}</span> : null}
                      </label>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <select className="input pill-select" value={prefs.projectKey ?? ''} onChange={(e) => setPrefs({ projectKey: e.target.value || null })}>
              <option value="">{agent?.scope === 'project' ? 'Pick a project' : 'All projects'}</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
            <span className="push" />
            {model ? <span className="muted small" title="Context window used">{pct}%</span> : null}
            {config && config.models.length > 1 ? (
              <select className="input pill-select" value={model?.id ?? ''} onChange={(e) => setPrefs({ model: e.target.value })}>
                {config.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : model ? (
              <span className="muted small">{model.label}</span>
            ) : null}
            {busy ? (
              <button type="button" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="button" disabled={!input.trim() || !config?.enabled} onClick={send}>
                Send
              </button>
            )}
          </div>
        </div>
      </footer>

      {reviewing && draft ? (
        <DraftReview
          draft={draft}
          options={options}
          onClose={() => setReviewing(false)}
          onChanged={(d) => {
            void refreshDrafts()
            if (d.status === 'submitted' && threadIdRef.current) void api<ChatThreadDetail>('GET', `/chat/threads/${threadIdRef.current}`).then((t) => setMessages(t.messages as unknown as UIMessage[]))
          }}
        />
      ) : null}
    </div>
  )
}
