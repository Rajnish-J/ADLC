// File checkpoints for orchestrator-driven runs. A harness without the SDLC tools (the `files` tier: no MCP, or its
// config file is tracked by the repository) cannot poll the platform itself, so this window polls for it: each step
// handed to the harness is written to its checkpoint file (`next-<harness>.md`), and the plan.md / done.md it
// writes back are submitted for it (see OrchestratedRun). Pure (no vscode), so it is unit-tested.

import type { NextStep, StepAssignment } from '@sdlc/contracts'
import { harnessLabel } from '@sdlc/contracts'
import { memoryOutboxHint } from './memoryOutbox'
import type { StepCompleteOptions, StepSource } from './stepSource'

/** What a files-tier harness reads for a step it is given. */
export function checkpointText(sessionDir: string, a: StepAssignment): string {
  const dir = `${sessionDir}/${a.stepId}`
  const role = a.agentFile ? `\nAct as the agent described in \`${a.agentFile}\`.\n` : ''
  const skills = a.skills.length
    ? `\n## Skills you may use\n\n${a.skills.map((s) => `- ${s.name}${s.path ? ` — \`${s.path}\`` : ''}`).join('\n')}\n`
    : ''
  if (a.action === 'plan') {
    return `# Step ${a.stepId} — PLAN as ${a.agentName}\n${role}\nWrite your plan (no file changes yet) to \`${dir}/plan.md\`, then wait: a human approves it in VS Code or on the web, and this file changes to EXECUTE.\n\n## Instructions\n\n${a.instructions}\n${skills}`
  }
  return (
    `# Step ${a.stepId} — EXECUTE as ${a.agentName}\n${role}\n` +
    `The plan below was approved. Do the work, then write a short summary to \`${dir}/done.md\`. ` +
    'Add a line `Skills used: a, b` if you used skills, and a line `Outputs: {"Local.TestsPassed": true}` (JSON) for run variables later conditions branch on.\n\n' +
    `${memoryOutboxHint(sessionDir)}\n\n` +
    `## Approved plan\n\n${a.approvedPlan ?? ''}\n\n## Instructions\n\n${a.instructions}\n${skills}`
  )
}

/** What the checkpoint file says while another harness has the run's next step. */
export function handoffText(harness: string): string {
  return `Another harness (**${harnessLabel(harness)}**) has the next step of this run. Stop here and end your turn — you are opened again when it is your turn.\n`
}

/** The skills and run variables a harness listed in its done.md. */
export function parseDone(text: string): StepCompleteOptions {
  const skillsUsed = /^skills used:\s*(.+)$/im.exec(text)?.[1].split(/[,\s]+/).filter(Boolean) ?? []
  let outputs: Record<string, unknown> | undefined
  const raw = /^outputs:\s*(\{.*\})\s*$/im.exec(text)?.[1]
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) outputs = v as Record<string, unknown>
    } catch {
      /* not JSON: ignored, the summary still goes through */
    }
  }
  return outputs ? { skillsUsed, outputs } : { skillsUsed }
}

const isAssignment = (n: NextStep): n is StepAssignment => n.action === 'plan' || n.action === 'execute'

export interface CheckpointPumpOptions {
  runId: string
  /** The harness's step source (the platform's steps for this harness). */
  source: Pick<StepSource, 'poll'>
  sessionDir: string
  /** Write the harness's checkpoint file. */
  write: (text: string) => Promise<void>
  log: (m: string) => void
  /** Long-poll length (ms). */
  pollMs?: number
  /** How long to wait for the harness's plan.md / done.md before asking the platform again (ms). */
  checkpointWaitMs?: number
  /** After an error, before trying again (ms). */
  retryMs?: number
}

/**
 * Polls the platform for a files-tier harness while it has work: writes each new step to its checkpoint file, waits
 * for the harness to write it back (`kick()` when it does), and stops when another harness has the next step
 * (start it again on the next `run.step` for this harness) or the run is over.
 */
export class CheckpointPump {
  private _running = false
  private stopped = false
  private wake: (() => void) | undefined
  private lastKey: string | undefined

  constructor(private readonly opts: CheckpointPumpOptions) {}

  get running(): boolean {
    return this._running
  }

  /** Start polling (no-op while it already is, or after stop()). */
  start(): void {
    if (this._running || this.stopped) return
    this._running = true
    void this.loop().finally(() => {
      this._running = false
    })
  }

  /** The harness wrote a checkpoint: ask the platform for what is next now. */
  kick(): void {
    this.wake?.()
    this.start()
  }

  stop(): void {
    this.stopped = true
    this.wake?.()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        if (this.wake === done) this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async loop(): Promise<void> {
    const { runId, source, sessionDir, write, log } = this.opts
    while (!this.stopped) {
      const started = Date.now()
      let next: NextStep
      try {
        next = await source.poll(runId, this.opts.pollMs ?? 25_000)
      } catch (err) {
        log(`Could not get the next step of run ${runId}: ${err instanceof Error ? err.message : String(err)}`)
        await this.sleep(this.opts.retryMs ?? 10_000)
        continue
      }
      if (this.stopped) return
      if (isAssignment(next)) {
        const key = `${next.stepId}:${next.action}`
        if (key !== this.lastKey) {
          this.lastKey = key
          await write(checkpointText(sessionDir, next)).catch((err: unknown) => log(String(err)))
        }
        await this.sleep(this.opts.checkpointWaitMs ?? 60_000)
      } else if (next.action === 'waiting') {
        // The platform long-polls; if it answered at once, do not spin.
        if (Date.now() - started < 1_000) await this.sleep(Math.max(1, next.retryAfterSec) * 1000)
      } else if (next.action === 'handoff') {
        this.lastKey = undefined
        await write(handoffText(next.harness)).catch((err: unknown) => log(String(err)))
        return
      } else {
        return // done / stopped: the session finishes the run
      }
    }
  }
}
