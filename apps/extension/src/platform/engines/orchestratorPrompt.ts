// The instructions a harness follows to run an SDLC workflow step by step (ORCHESTRATOR.md) and the short prompt it
// is opened with. Pure, so it is unit-tested. The protocol is the same for every harness; only how it reaches the
// SDLC tools differs (MCP tools, or files under .sdlc/sessions for harnesses without MCP).
//
// Two kinds of run: the extension runs the workflow itself and one harness works every step, or the platform's
// orchestrator runs it and hands each agent step to the harness pinned to it — then each harness gets its own
// protocol file and prompt, and is told to end its turn when another harness has the next step.

import { harnessLabel, type HarnessTier } from '@sdlc/contracts'
import { memoryOutboxHint } from '../session/memoryOutbox'

export interface OrchestratorInput {
  runId: string
  /** null for a quick fix started from a prompt (no story). */
  storyKey: string | null
  storyTitle: string | null
  /** A quick fix (no story): the prompt's first line, for the instructions. The whole prompt is in `prompt.md`. */
  quickFix?: string | null
  taskKey?: string | null
  taskTitle?: string | null
  workflowName: string
  /** `harness`: the harness that runs the step (orchestrator-driven runs). */
  steps: Array<{ label: string; agentName: string | null; skills: string[]; harness?: string | null }>
  /** Workspace-relative folder of the session files (`.sdlc/sessions/PAY-2`). */
  sessionDir: string
  tier: HarnessTier
  /**
   * Set for orchestrator-driven runs: the harness these instructions are for. It works only its own steps, and
   * gets its own protocol file (and checkpoint file at the `files` tier).
   */
  harness?: { id: string; label?: string }
}

/** The protocol file a harness follows: ORCHESTRATOR.md, or one per harness for orchestrator-driven runs. */
export function protocolFile(i: Pick<OrchestratorInput, 'sessionDir' | 'harness'>): string {
  return i.harness ? `${i.sessionDir}/ORCHESTRATOR-${i.harness.id}.md` : `${i.sessionDir}/ORCHESTRATOR.md`
}

/** The checkpoint file a `files`-tier harness reads for its current step. */
export function nextFile(i: Pick<OrchestratorInput, 'sessionDir' | 'harness'>): string {
  return i.harness ? `${i.sessionDir}/next-${i.harness.id}.md` : `${i.sessionDir}/next.md`
}

const labelOf = (h: { id: string; label?: string }): string => h.label ?? harnessLabel(h.id)

/** The first line of a prompt, shortened — how a quick fix is named in prompts and titles. */
export function promptSummary(prompt: string, max = 80): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** What the run works on, in a sentence: a task, a story, or a quick fix. */
function targetOf(i: Pick<OrchestratorInput, 'storyKey' | 'storyTitle' | 'taskKey' | 'taskTitle' | 'quickFix'>): string {
  if (i.taskKey) return `task ${i.taskKey} — ${i.taskTitle} (of story ${i.storyKey} — ${i.storyTitle})`
  if (i.storyKey) return `story ${i.storyKey} — ${i.storyTitle}`
  return `the quick fix “${i.quickFix || 'described in prompt.md'}”`
}

export function orchestratorMarkdown(i: OrchestratorInput): string {
  const target = targetOf(i)
  const mine = i.harness
  const where = (h: string | null | undefined): string => {
    if (!mine || !h) return ''
    return h === mine.id ? ` — **you** (${labelOf(mine)})` : ` — in ${harnessLabel(h)}`
  }
  const steps = i.steps
    .map(
      (s, n) =>
        `${n + 1}. **${s.label}**${s.agentName ? ` — agent: ${s.agentName}` : ''}${s.skills.length ? ` — skills: ${s.skills.join(', ')}` : ''}${where(s.harness)}`,
    )
    .join('\n')
  const next = nextFile(i)
  const protocol = mine ? orchestratedProtocol(i, next) : localProtocol(i, next)
  const intro = mine
    ? [
        `You are working the **${labelOf(mine)}** steps of the **${i.workflowName}** workflow on ${target}.`,
        'The SDLC platform runs the workflow and hands each agent step to the harness it is pinned to — other steps run in other harnesses. ' +
          'Act as each of your steps’ agent and use its skills. Governance gates and human approvals run between steps — never skip ahead.',
      ]
    : [
        `You are running the **${i.workflowName}** workflow on ${target}.`,
        'Work through the steps below **in order**, acting as each step’s agent and using its skills. Governance gates and human approvals run between steps — never skip ahead.',
      ]
  return [
    `# SDLC workflow run [sdlc:run=${i.runId}]`,
    '',
    ...intro,
    '',
    '## Steps',
    steps || '_(the workflow has no agent steps)_',
    '',
    '## How to run each step',
    ...protocol,
    '',
    i.storyKey
      ? `The story, its acceptance criteria and the project knowledge are in \`${i.sessionDir}/story.md\` and \`${i.sessionDir}/memory.md\`.`
      : `There is no story: the fix to make is described in \`${i.sessionDir}/prompt.md\` (\`sdlc_get_story\` returns it too). Project knowledge is in \`${i.sessionDir}/memory.md\`. Keep the change small and focused on what it asks.`,
    'Work on the current git branch. Do not commit files under `.sdlc/`.',
    '',
  ].join('\n')
}

/** The extension runs the workflow and this harness works every step (unchanged from before orchestrated runs). */
function localProtocol(i: OrchestratorInput, next: string): string[] {
  return i.tier === 'files'
    ? [
        `1. Read \`${next}\`. It says which step you are on, which agent you act as, and what to do now.`,
        `2. If it asks for a **plan**: write your plan (no code changes yet) to \`${i.sessionDir}/<stepId>/plan.md\`, then wait — a human approves it in VS Code. When \`next.md\` changes to **execute**, continue.`,
        `3. For **execute**: do the work the approved plan describes, then write a short summary of what you changed to \`${i.sessionDir}/<stepId>/done.md\` (list any skills you used on a line \`Skills used: a, b\`).`,
        `4. Read \`next.md\` again for the next step. Stop when it says the run is **done** or **stopped**.`,
      ]
    : [
        '1. Call `sdlc_next_step`. It returns your current step: the agent you act as (with its instructions), the skills you may use, and whether to **plan** or **execute**.',
        '2. For **plan**: investigate as needed but do not change files. Call `sdlc_submit_plan` with the step id and a concrete plan.',
        '3. Call `sdlc_next_step` again. While it says **waiting**, a human is reviewing your plan or a governance gate is running — keep calling it. When it returns **execute** with the approved plan, do the work.',
        '4. Call `sdlc_complete_step` with the step id, a short summary of what you changed, and the skills you used.',
        '5. Repeat from 1 until `sdlc_next_step` says **done** or **stopped**. If a plan is rejected, the run stops.',
        'Use `sdlc_get_story` and `sdlc_get_memory` for context, and `sdlc_add_memory` to record decisions and conventions worth keeping.',
      ]
}

/** The platform runs the workflow; this harness works only the steps handed to it. */
function orchestratedProtocol(i: OrchestratorInput, next: string): string[] {
  const name = next.split('/').pop() ?? next
  return i.tier === 'files'
    ? [
        `1. Read \`${next}\`. It says which step you are on, which agent you act as, and what to do now.`,
        `2. If it asks for a **plan**: write your plan (no code changes yet) to \`${i.sessionDir}/<stepId>/plan.md\`, then wait — a human approves it in VS Code or on the web. When \`${name}\` changes to **execute**, continue.`,
        `3. For **execute**: do the work the approved plan describes (some steps skip the plan and go straight to execute — then do the step's work directly), then write a short summary of what you changed to \`${i.sessionDir}/<stepId>/done.md\`. List any skills you used on a line \`Skills used: a, b\`, and any run variables the step sets for later conditions on a line \`Outputs: {"Local.TestsPassed": true}\` (JSON). Do not commit or push — VS Code commits each step's changes to the run branch for you.`,
        `4. Read \`${name}\` again for your next step. If it says **another harness** has the next step, stop and end your turn — you are opened again when it is your turn. Stop when it says the run is **done** or **stopped**.`,
        memoryOutboxHint(i.sessionDir),
      ]
    : [
        '1. Call `sdlc_next_step`. It returns your current step: the agent you act as (with its instructions), the skills you may use, and whether to **plan** or **execute**.',
        '2. For **plan**: investigate as needed but do not change files. Call `sdlc_submit_plan` with the step id and a concrete plan.',
        '3. Call `sdlc_next_step` again. While it returns **waiting**, a human is reviewing your plan or a governance gate is running — wait `retryAfterSec` seconds, then call it again. When it returns **execute** with the approved plan, do the work. Some steps skip the plan: `sdlc_next_step` returns **execute** straight away (no approved plan) — then do the step’s work directly.',
        '4. Call `sdlc_complete_step` with the step id, a short summary of what you changed, and the skills you used. If the step decides something later steps branch on, pass it as `outputs` — run variables, e.g. `{"Local.TestsPassed": true}`. Do not commit or push: VS Code commits each step’s changes to the run branch for you.',
        '5. Repeat from 1. If `sdlc_next_step` returns **handoff**, another harness has the next step: stop and end your turn — you are opened again when it is your turn. Stop when it says **done** or **stopped**. If a plan is rejected, the run stops.',
        'Use `sdlc_get_story` and `sdlc_get_memory` for context, and `sdlc_add_memory` to record decisions and conventions worth keeping.',
        `If \`sdlc_add_memory\` is not available: ${memoryOutboxHint(i.sessionDir)}`,
      ]
}

/** The short prompt the harness is opened with. */
export function launchPrompt(
  i: Pick<OrchestratorInput, 'runId' | 'storyKey' | 'taskKey' | 'sessionDir' | 'workflowName' | 'tier' | 'harness' | 'quickFix'>,
): string {
  const what = i.taskKey ?? i.storyKey ?? `the quick fix “${i.quickFix || 'in prompt.md'}”`
  if (i.harness) {
    const start = i.tier === 'files' ? `read ${nextFile(i)}` : 'call the sdlc_next_step tool'
    const stop =
      i.tier === 'files'
        ? 'If it says another harness has the next step, stop and end your turn.'
        : 'If it returns action "handoff", another harness has the next step: stop and end your turn. If it returns "waiting", wait retryAfterSec seconds and call it again; stop on "done" or "stopped".'
    return (
      `[sdlc:run=${i.runId}] You are working the ${labelOf(i.harness)} steps of this run: the ${i.workflowName} workflow on ${what}. ` +
      `Follow ${protocolFile(i)} exactly: ${start} to get your step. ${stop}`
    )
  }
  const start = i.tier === 'files' ? `read ${i.sessionDir}/next.md` : 'call the sdlc_next_step tool'
  return `[sdlc:run=${i.runId}] Run the ${i.workflowName} workflow on ${what}. Follow ${i.sessionDir}/ORCHESTRATOR.md exactly: ${start} to get your first step.`
}
