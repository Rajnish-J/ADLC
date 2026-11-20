// Phase 4 — Runs tree. Surfaces workflow runs and their steps with live status:
//   <Run> (status) → <Step> (status, gate verdict / approval prompt) → <Evaluator> (score vs threshold)
// A gate step expands to the evaluator scores behind its verdict and a link to the full report.
// Runs awaiting approval expose approve/reject; active runs expose cancel (wired via context values + menus).

import * as vscode from 'vscode'
import type { RunService } from '../runtime/runService'
import type { RunState, RunStatus, RunStep } from '../runtime/port'
import type { EvaluatorDecision } from '../eval/types'

type Node = RunNode | StepNode | EvaluatorNode | MessageNode

export class RunNode extends vscode.TreeItem {
  constructor(public readonly run: RunState) {
    super(run.workflowName, vscode.TreeItemCollapsibleState.Expanded)
    this.description = describeRun(run)
    this.iconPath = runIcon(run.status)
    this.tooltip = `${run.runId}\nactor: ${run.actor}\nstatus: ${run.status}${
      run.error ? `\nerror: ${run.error}` : ''
    }`
    // Drives which inline actions appear (see package.json menus).
    this.contextValue =
      run.status === 'awaiting_approval'
        ? 'sdlcRun.awaitingApproval'
        : run.status === 'running' || run.status === 'queued'
          ? 'sdlcRun.active'
          : 'sdlcRun.done'
  }
}

class StepNode extends vscode.TreeItem {
  constructor(public readonly step: RunStep) {
    super(
      `${step.seq}. ${step.label}`,
      step.gateDecision && (step.gateDecision.perEvaluator.length > 0 || step.gateDecision.reportUrl)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    )
    this.description = describeStep(step)
    this.iconPath = stepIcon(step)
    this.tooltip = buildStepTooltip(step)
  }
}

/** One evaluator's score behind a gate verdict. */
class EvaluatorNode extends vscode.TreeItem {
  constructor(d: EvaluatorDecision) {
    super(d.evaluator, vscode.TreeItemCollapsibleState.None)
    const score = d.score === null ? '—' : Number.isInteger(d.score) ? String(d.score) : d.score.toFixed(2)
    const threshold = d.threshold === null ? 'n/a' : String(d.threshold)
    this.description = `${score} / ${threshold} · ${d.pass ? 'pass' : 'fail'}${d.required ? '' : ' (advisory)'}`
    this.tooltip = d.reason
    this.iconPath = d.pass
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info', command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
    if (command) this.command = command
  }
}

export class RunsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly runs: RunService) {
    runs.onDidChange(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  getChildren(element?: Node): Node[] {
    if (element instanceof RunNode) {
      return element.run.steps.map((s) => new StepNode(s))
    }
    if (element instanceof StepNode) {
      const decision = element.step.gateDecision
      if (!decision) return []
      const rows: Node[] = decision.perEvaluator.map((d) => new EvaluatorNode(d))
      if (decision.reportUrl) {
        rows.push(
          new MessageNode('Open full evaluation report', 'link-external', {
            command: 'vscode.open',
            title: 'Open full evaluation report',
            arguments: [vscode.Uri.parse(decision.reportUrl)],
          }),
        )
      }
      return rows
    }
    if (element) return []

    const all = this.runs.list()
    if (all.length === 0) {
      return [new MessageNode('No runs yet. Use “Run Workflow” to start one.', 'play')]
    }
    return all.map((r) => new RunNode(r))
  }
}

function describeRun(run: RunState): string {
  if (run.status === 'awaiting_approval') return 'awaiting approval'
  const done = run.steps.filter((s) => s.status !== 'running').length
  return `${run.status} · ${done}/${run.steps.length} steps`
}

function describeStep(step: RunStep): string {
  if (step.kind === 'gate' && step.gateDecision) {
    return step.gateDecision.pass ? 'gate: pass' : `gate: BLOCKED — ${step.gateDecision.reason}`
  }
  if (step.kind === 'approval') return step.output ?? 'awaiting approval'
  if (step.tokensIn !== undefined) return `${step.status} · ${step.tokensIn + (step.tokensOut ?? 0)} tok`
  return step.status
}

function runIcon(status: RunStatus): vscode.ThemeIcon {
  switch (status) {
    case 'completed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash')
    case 'awaiting_approval':
      return new vscode.ThemeIcon('person', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
    default:
      return new vscode.ThemeIcon('loading~spin')
  }
}

function stepIcon(step: RunStep): vscode.ThemeIcon {
  switch (step.status) {
    case 'succeeded':
      return new vscode.ThemeIcon('check')
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
    case 'blocked':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'))
    case 'skipped':
      return new vscode.ThemeIcon('dash')
    default:
      return new vscode.ThemeIcon('loading~spin')
  }
}

function buildStepTooltip(step: RunStep): string {
  const lines = [`${step.label} (${step.kind})`, `status: ${step.status}`]
  if (step.gateDecision) {
    lines.push(`gate: ${step.gateDecision.pass ? 'pass' : 'fail'} — ${step.gateDecision.reason}`)
    for (const d of step.gateDecision.perEvaluator) {
      lines.push(`  • ${d.evaluator}: ${d.score ?? 'n/a'} vs ${d.threshold ?? 'n/a'} → ${d.pass ? 'pass' : 'fail'}`)
    }
  }
  if (step.output) lines.push('', step.output.slice(0, 400))
  if (step.error) lines.push('', `error: ${step.error}`)
  return lines.join('\n')
}
