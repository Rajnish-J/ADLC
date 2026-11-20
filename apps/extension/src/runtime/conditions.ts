// Phase 4 — condition predicate evaluation. Ported verbatim from the orka orchestrator
// (claude-code-analytics src/lib/orka/orchestrator/conditions.ts). Pure. See plan §3.5.
//
// A small, safe subset of PowerFx — no eval(), no function calls beyond the comparisons supported.
// Deliberately forgiving: anything unparseable resolves falsy so a malformed predicate can't crash a run.
// Used for handoff routing (condition nodes); an empty predicate (ELSE) is always true.
//
//   Local.X = "FEATURE"      (= and == both mean equality, PowerFx style)
//   Local.Count >= 8         (numeric comparison when both sides are numbers)
//   Local.A <> "x"           (<> and != both mean inequality)
//   <expr> And <expr>        (also && )
//   <expr> Or  <expr>        (also || )

import { RunContext } from './context'

type Operator = '=' | '==' | '<>' | '!=' | '>=' | '<=' | '>' | '<'

const OPERATORS: Operator[] = ['==', '>=', '<=', '<>', '!=', '=', '>', '<']

export function evaluateCondition(predicate: string | undefined | null, ctx: RunContext): boolean {
  const expr = (predicate ?? '').trim()
  if (!expr) return true // ELSE / unconditional

  const orParts = splitOnKeywords(expr, ['Or', '||'])
  if (orParts.length > 1) return orParts.some((p) => evaluateCondition(p, ctx))

  const andParts = splitOnKeywords(expr, ['And', '&&'])
  if (andParts.length > 1) return andParts.every((p) => evaluateCondition(p, ctx))

  return evaluateComparison(expr, ctx)
}

function splitOnKeywords(expr: string, keywords: string[]): string[] {
  for (const kw of keywords) {
    const re =
      kw === 'And' || kw === 'Or'
        ? new RegExp(`\\s+${kw}\\s+`, 'i')
        : new RegExp(`\\s*\\${kw[0]}\\${kw[1]}\\s*`)
    if (re.test(expr)) {
      return expr.split(re).map((s) => s.trim()).filter(Boolean)
    }
  }
  return [expr]
}

function evaluateComparison(expr: string, ctx: RunContext): boolean {
  for (const op of OPERATORS) {
    const idx = expr.indexOf(op)
    if (idx === -1) continue
    const lhs = expr.slice(0, idx).trim()
    const rhs = expr.slice(idx + op.length).trim()
    if (!lhs || !rhs) continue
    const left = resolveOperand(lhs, ctx)
    const right = resolveOperand(rhs, ctx)
    return compare(left, right, op)
  }
  const val = resolveOperand(expr, ctx)
  return Boolean(val) && val !== '0' && val !== 0 && val !== 'false'
}

function resolveOperand(token: string, ctx: RunContext): unknown {
  const t = token.trim().replace(/^=/, '').trim()
  const quoted = t.match(/^"(.*)"$|^'(.*)'$/)
  if (quoted) return quoted[1] ?? quoted[2] ?? ''
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  return ctx.get(t)
}

function compare(left: unknown, right: unknown, op: Operator): boolean {
  const bothNumeric =
    typeof left !== 'object' &&
    typeof right !== 'object' &&
    left !== '' &&
    right !== '' &&
    !Number.isNaN(Number(left)) &&
    !Number.isNaN(Number(right))

  if (bothNumeric) {
    const a = Number(left)
    const b = Number(right)
    switch (op) {
      case '=':
      case '==': return a === b
      case '<>':
      case '!=': return a !== b
      case '>': return a > b
      case '<': return a < b
      case '>=': return a >= b
      case '<=': return a <= b
    }
  }

  const a = String(left ?? '')
  const b = String(right ?? '')
  switch (op) {
    case '=':
    case '==': return a === b
    case '<>':
    case '!=': return a !== b
    case '>': return a > b
    case '<': return a < b
    case '>=': return a >= b
    case '<=': return a <= b
    default: return false
  }
}
