// Phase 4 — run variable bag. Ported verbatim from the orka orchestrator
// (claude-code-analytics src/lib/orka/orchestrator/context.ts). Pure. See plan §3.5.
//
// Variables are keyed by their full dotted name (e.g. "Local.WorkItem", "System.LastMessage.Text").
// set-variable mutates it; agent output merges into it; condition predicates read from it.

export class RunContext {
  private vars = new Map<string, unknown>()

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) this.vars.set(k, v)
    }
  }

  get(name: string): unknown {
    if (this.vars.has(name)) return this.vars.get(name)
    // tolerate a leading "=" or surrounding spaces
    const trimmed = name.trim().replace(/^=/, '')
    return this.vars.get(trimmed)
  }

  set(name: string, value: unknown): void {
    this.vars.set(name.trim(), value)
  }

  reset(name: string): void {
    this.vars.set(name.trim(), '')
  }

  /** Convenience for the conventional "last assistant message" slot. */
  setLastMessage(text: string): void {
    this.set('System.LastMessage.Text', text)
  }

  getLastMessage(): string {
    return String(this.get('System.LastMessage.Text') ?? '')
  }

  /**
   * Resolves a PowerFx-ish value expression used by set-variable.value.
   * - "=System.LastMessage.Text" → resolves the variable
   * - "=Local.Foo" → resolves the variable
   * - '="literal"' or "literal" → literal string
   * Unknown paths resolve to ''.
   */
  interpolate(expr: unknown): unknown {
    if (typeof expr !== 'string') return expr
    const raw = expr.trim()
    if (!raw.startsWith('=')) return raw
    const body = raw.slice(1).trim()
    const quoted = body.match(/^"(.*)"$|^'(.*)'$/)
    if (quoted) return quoted[1] ?? quoted[2] ?? ''
    if (/^-?\d+(\.\d+)?$/.test(body)) return Number(body)
    const resolved = this.get(body)
    return resolved === undefined ? '' : resolved
  }

  toBag(): Record<string, unknown> {
    return Object.fromEntries(this.vars.entries())
  }
}
