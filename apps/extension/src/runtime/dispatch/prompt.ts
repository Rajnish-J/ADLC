// Pure prompt assembly for agent dispatches, split from lmAgentDispatcher.ts so it carries no `vscode`
// dependency — server-side dispatchers must build the exact same prompt the extension does.

/**
 * Assemble the single user turn for an agent dispatch. The LM API has no system role, so we prepend
 * the agent's instructions, then always include the persistent work item (so downstream agents never
 * lose it), then the prior step's output as a handoff. A framing line tells the agent to act rather
 * than ask for the work item. Pure/testable (no `vscode`).
 */
export function assembleAgentPrompt(args: {
  instructions: string
  workItem?: string
  workItemId?: number
  workItemUrl?: string
  prior: string
  /** True for the planning turn — instructs the model to produce a plan only, no actions. */
  planOnly?: boolean
  /** The human-approved plan, included on the execute turn so the agent follows through on it. */
  approvedPlan?: string
}): string {
  const instructions = args.instructions.trim()
  const workItem = (args.workItem ?? '').trim()
  const prior = (args.prior ?? '').trim()
  const approvedPlan = (args.approvedPlan ?? '').trim()
  const sections: string[] = []
  if (instructions) sections.push(instructions)

  if (workItem) {
    const idLine = args.workItemId ? `Work item: #${args.workItemId}` : ''
    const urlLine = args.workItemUrl ? `Source: ${args.workItemUrl}` : ''
    const meta = [idLine, urlLine].filter(Boolean).join('\n')
    sections.push(`## Work Item${meta ? `\n${meta}` : ''}\n\n${workItem}`)
  }

  // The handoff from the previous agent. Skip it when it's empty or identical to the work item (true
  // for the first agent, whose last-message slot still holds the seed).
  if (prior && prior !== workItem) {
    sections.push(`## Prior step output\n\n${prior}`)
  }

  if (approvedPlan) {
    sections.push(`## Approved plan\n\n${approvedPlan}\n\nCarry out this plan now.`)
  } else if (workItem) {
    sections.push(
      'The work item is provided above — do not ask the user for it. Produce your deliverable ' +
        'directly; use the available tools only as needed.',
    )
  }

  if (args.planOnly) {
    sections.push(
      'Before doing anything else, produce a concise, numbered PLAN of the concrete actions you ' +
        'will take to complete this work. Do NOT perform any action or call any tool yet — output ' +
        'only the plan as plain text.',
    )
  }

  return sections.join('\n\n---\n\n')
}

/** One-line, human-readable marker for a tool call, e.g. `write_file(src/x.ts)`. Pure/testable. */
export function summarizeToolCall(call: { name: string; input?: unknown }): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const detail =
    typeof input.path === 'string'
      ? input.path
      : typeof input.query === 'string'
        ? `"${String(input.query).slice(0, 40)}"`
        : ''
  return detail ? `${call.name}(${detail})` : call.name
}
