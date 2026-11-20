// Run activity: the event log of a workflow run in a harness — which step and agent were running, which skills and
// tools they used, which files they touched, the plans submitted and the approvals decided. The extension builds it
// from the harness's checkpoint tool calls and hooks and reports it in batches; both UIs show it as a timeline.
// Tool inputs are never stored raw: only the tool name, a file path and a short, redacted summary.

import { z } from 'zod'

export const RUN_EVENT_TYPES = [
  'session.started',
  'harness.opened',
  'step.started',
  'plan.submitted',
  'approval.requested',
  'approval.decided',
  'step.completed',
  'agent.started',
  'agent.stopped',
  'skill.used',
  'tool.called',
  'tool.failed',
  'file.changed',
  'memory.read',
  'memory.written',
  'gate.evaluated',
  'turn.stopped',
  'nudge',
  'usage',
] as const
export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

export const RUN_EVENT_LABELS: Record<RunEventType, string> = {
  'session.started': 'Session started',
  'harness.opened': 'Harness opened',
  'step.started': 'Step started',
  'plan.submitted': 'Plan submitted',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'step.completed': 'Step completed',
  'agent.started': 'Agent started',
  'agent.stopped': 'Agent stopped',
  'skill.used': 'Skill used',
  'tool.called': 'Tool call',
  'tool.failed': 'Tool failed',
  'file.changed': 'File changed',
  'memory.read': 'Memory read',
  'memory.written': 'Memory written',
  'gate.evaluated': 'Gate evaluated',
  'turn.stopped': 'Turn ended',
  nudge: 'Nudged',
  usage: 'Usage',
}

/** How the platform knows a skill was used: seen in the harness's activity, or declared by the agent. */
export const SKILL_EVIDENCE = ['observed', 'declared'] as const
export type SkillEvidence = (typeof SKILL_EVIDENCE)[number]

export const MAX_RUN_EVENT_SUMMARY = 300

export const RunEventInputSchema = z.object({
  /** Per run, increasing; reports are idempotent on it. */
  seq: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true }),
  type: z.enum(RUN_EVENT_TYPES),
  stepId: z.string().max(200).nullable().default(null),
  agentType: z.string().max(200).nullable().default(null),
  agentName: z.string().max(200).nullable().default(null),
  skill: z.string().max(200).nullable().default(null),
  tool: z.string().max(200).nullable().default(null),
  path: z.string().max(1_000).nullable().default(null),
  summary: z.string().max(MAX_RUN_EVENT_SUMMARY + 20).nullable().default(null),
  /** Small structured extras: tokens, model, evidence, decision. Redacted by the reporter. */
  data: z.record(z.unknown()).default({}),
})
export type RunEventInput = z.input<typeof RunEventInputSchema>

export const ReportRunEventsInputSchema = z.object({
  events: z.array(RunEventInputSchema).min(1).max(200),
})
export type ReportRunEventsInput = z.input<typeof ReportRunEventsInputSchema>

export const RunEventSchema = RunEventInputSchema.extend({
  stepId: z.string().nullable(),
  agentType: z.string().nullable(),
  agentName: z.string().nullable(),
  skill: z.string().nullable(),
  tool: z.string().nullable(),
  path: z.string().nullable(),
  summary: z.string().nullable(),
  data: z.record(z.unknown()),
})
export type RunEvent = z.infer<typeof RunEventSchema>

export const RunEventsPageSchema = z.object({
  events: z.array(RunEventSchema),
  /** The highest seq stored for the run; poll again with `after=lastSeq`. */
  lastSeq: z.number().int(),
})
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>

export const RunEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
})
export type RunEventsQuery = z.input<typeof RunEventsQuerySchema>

/** Cuts a summary to the stored length. */
export function clipSummary(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_RUN_EVENT_SUMMARY ? `${t.slice(0, MAX_RUN_EVENT_SUMMARY - 1)}…` : t
}
