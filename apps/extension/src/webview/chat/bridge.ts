// The Chat webview's link to the extension host: API calls answered by the host (it holds the platform identity),
// and an AI SDK ChatTransport whose stream is the event stream the host forwards in chunks.

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { ApiMethod, ChatToHost, HostToChat } from '../../platform/chat/chatPanelMessages'

interface VsCodeApi {
  postMessage(message: ChatToHost): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

type StreamMessage = Extract<HostToChat, { type: 'chunk' | 'end' | 'streamError' }>

let seq = 0
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>()
const streams = new Map<string, (msg: StreamMessage) => void>()
const listeners = new Set<(msg: HostToChat) => void>()

window.addEventListener('message', (ev: MessageEvent<HostToChat>) => {
  const msg = ev.data
  if (msg.type === 'response') {
    const p = pending.get(msg.requestId)
    pending.delete(msg.requestId)
    if (!p) return
    if (msg.ok) p.resolve(msg.data)
    else p.reject(new ApiError(msg.message ?? 'Request failed.', msg.status))
    return
  }
  if (msg.type === 'chunk' || msg.type === 'end' || msg.type === 'streamError') {
    streams.get(msg.requestId)?.(msg)
    return
  }
  for (const l of listeners) l(msg)
})

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function post(msg: ChatToHost): void {
  vscode.postMessage(msg)
}

export function onHost(listener: (msg: HostToChat) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function api<T>(method: ApiMethod, path: string, body?: unknown): Promise<T> {
  const requestId = `r${++seq}`
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: (d) => resolve(d as T), reject })
    post({ type: 'request', requestId, method, path, ...(body !== undefined ? { body } : {}) })
  })
}

export function loadState<T>(): Partial<T> {
  return (vscode.getState() as Partial<T> | undefined) ?? {}
}

export function saveState<T>(state: T): void {
  vscode.setState(state)
}

/** Parses `data: {...}` events out of the forwarded text; returns what is left of an incomplete event. */
function drain(buffer: string, emit: (chunk: UIMessageChunk) => void): string {
  const events = buffer.split(/\r?\n\r?\n/)
  const rest = events.pop() ?? ''
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    try {
      emit(JSON.parse(data) as UIMessageChunk)
    } catch {
      // A malformed event is skipped rather than ending the answer.
    }
  }
  return rest
}

/** useChat's transport: `prepare` turns the conversation into the POST /chat body (creating the thread if needed). */
export class HostChatTransport implements ChatTransport<UIMessage> {
  constructor(private readonly prepare: (messages: UIMessage[]) => Promise<object>) {}

  async sendMessages(options: { messages: UIMessage[]; abortSignal: AbortSignal | undefined }): Promise<ReadableStream<UIMessageChunk>> {
    const body = await this.prepare(options.messages)
    const requestId = `s${++seq}`
    let closed = false
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        let buffer = ''
        const finish = (err?: Error) => {
          if (closed) return
          closed = true
          streams.delete(requestId)
          if (err) controller.error(err)
          else controller.close()
        }
        streams.set(requestId, (msg) => {
          if (msg.type === 'chunk') buffer = drain(buffer + msg.text, (c) => !closed && controller.enqueue(c))
          else if (msg.type === 'end') {
            drain(`${buffer}\n\n`, (c) => !closed && controller.enqueue(c))
            finish()
          } else finish(new ApiError(msg.message, msg.status))
        })
        options.abortSignal?.addEventListener('abort', () => {
          post({ type: 'abort', requestId })
          finish()
        })
        post({ type: 'send', requestId, body })
      },
      cancel() {
        post({ type: 'abort', requestId })
        closed = true
        streams.delete(requestId)
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }
}
