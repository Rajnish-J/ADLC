// The local bridge: a loopback-only HTTP server in this VS Code window that the chosen harness talks to while it
// runs a workflow. It serves the SDLC tools over MCP (Streamable HTTP, JSON responses — plain JSON-RPC, no SDK)
// at /mcp/<token>, and receives harness hooks at /hooks/<token>/<engine>. Each run session has its own random
// token in the path; requests from browsers (an Origin header) and to other hosts are refused.

import { randomBytes } from 'crypto'
import * as http from 'http'
import type { AddressInfo } from 'net'

export interface BridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Returns JSON-serializable data; throw to report a tool error to the harness. */
  call(args: Record<string, unknown>): Promise<unknown>
}

export interface BridgeSession {
  runId: string
  engine: string
  tools: BridgeTool[]
  /** A hook payload from the harness (already parsed JSON). */
  onHook?(engine: string, payload: unknown): void
  /** Every tool call, for the activity log. */
  onToolCall?(name: string, args: Record<string, unknown>, ok: boolean): void
}

export interface BridgeEndpoints {
  token: string
  mcpUrl: string
  hookUrl: (engine: string) => string
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024

type JsonRpcId = string | number | null
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export class LocalBridge {
  private server: http.Server | undefined
  private port = 0
  private readonly sessions = new Map<string, BridgeSession>()

  constructor(private readonly version: string) {}

  /** Start listening (idempotent). */
  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  /** Register a run session; its token is the only way to reach it. */
  open(session: BridgeSession): BridgeEndpoints {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, session)
    const base = `http://127.0.0.1:${this.port}`
    return { token, mcpUrl: `${base}/mcp/${token}`, hookUrl: (engine) => `${base}/hooks/${token}/${engine}` }
  }

  close(token: string): void {
    this.sessions.delete(token)
  }

  dispose(): void {
    this.sessions.clear()
    this.server?.close()
    this.server = undefined
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Only local, non-browser callers: a web page could otherwise reach a loopback port.
      const host = (req.headers.host ?? '').split(':')[0]
      if ((host !== '127.0.0.1' && host !== 'localhost') || req.headers.origin) return send(res, 403, { error: 'forbidden' })
      const [, kind, token, engine] = (req.url ?? '').split('?')[0].split('/')
      const session = token ? this.sessions.get(token) : undefined
      if (!session) return send(res, 404, { error: 'unknown session' })

      if (kind === 'hooks' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          session.onHook?.(engine || session.engine, body ? JSON.parse(body) : {})
        } catch {
          /* malformed hook payloads are ignored — hooks must never block the harness */
        }
        return send(res, 200, {})
      }
      if (kind !== 'mcp') return send(res, 404, { error: 'not found' })
      if (req.method === 'GET') return send(res, 405, { error: 'This server does not open an SSE stream.' })
      if (req.method === 'DELETE') return send(res, 200, {})
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })

      const raw = await readBody(req)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return send(res, 400, rpcError(null, -32700, 'Parse error'))
      }
      const batch = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest]
      const replies = (await Promise.all(batch.map((m) => this.rpc(session, m)))).filter((r) => r !== undefined)
      if (replies.length === 0) {
        res.writeHead(202).end()
        return
      }
      res.setHeader('Mcp-Session-Id', token)
      send(res, 200, Array.isArray(parsed) ? replies : replies[0])
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async rpc(session: BridgeSession, msg: JsonRpcRequest): Promise<unknown> {
    const id = msg.id ?? null
    const isNotification = msg.id === undefined
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '')
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sdlc', title: 'SDLC governance', version: this.version },
          instructions:
            'Tools for running an SDLC workflow step by step. Call sdlc_next_step to get your current step, ' +
            'sdlc_submit_plan with your plan, wait for approval via sdlc_next_step, then sdlc_complete_step when done.',
        })
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, {
          tools: session.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })
      case 'tools/call': {
        const name = String(msg.params?.name ?? '')
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
        const tool = session.tools.find((t) => t.name === name)
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`)
        try {
          const data = await tool.call(args)
          session.onToolCall?.(name, args, true)
          return rpcResult(id, { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], structuredContent: typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined })
        } catch (err) {
          session.onToolCall?.(name, args, false)
          return rpcResult(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
        }
      }
      default:
        return isNotification ? undefined : rpcError(id, -32601, `Method not found: ${msg.method}`)
    }
  }
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
