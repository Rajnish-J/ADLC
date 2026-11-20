// Phase 3 — the Azure DevOps gate scaffolder.
//
// Writes three files into the workspace so a failing Foundry evaluation BLOCKS
// the PR (when wired as a required branch-policy build):
//   • .sdlc/eval/dataset.json            — evaluators + queries the task runs
//   • azure-pipelines-eval-gate.yml      — the AIAgentEvaluation@2 gate pipeline
//   • .sdlc/eval/README.md               — operator prerequisites + cost guidance
//
// Pure renderers (renderDatasetJson / renderPipelineYaml / renderReadme) are
// unit-tested; the write wrapper is the only `vscode`-touching part and never
// overwrites without confirmation.

import * as vscode from 'vscode'
import { DEFAULT_STEP_EVALUATORS, type SdlcStep } from '../eval/sdlcSteps'
import type { EvalDataset } from '../eval/types'

export interface ScaffoldOptions {
  step: SdlcStep
  judgeDeployment: string
}

export interface WrittenFile {
  path: string
  uri: vscode.Uri
}

const DATASET_REL = '.sdlc/eval/dataset.json'
const PIPELINE_REL = 'azure-pipelines-eval-gate.yml'
const README_REL = '.sdlc/eval/README.md'

/**
 * Build the starter dataset for a step (built-in evaluators + sample queries).
 *
 * Note the contract differs from the in-extension evals API: the
 * `AIAgentEvaluation@2` task *invokes the deployed agents* to generate responses
 * and auto-generates the field mapping from the data, pulling `tool_definitions`
 * from the real agent run. So we deliberately emit query-only rows and NO
 * `data_mapping` — a hand-written mapping pointing at a `response`/`ground_truth`
 * column that doesn't exist would override the task's auto-mapping and break it.
 */
export function buildScaffoldDataset(opts: ScaffoldOptions): EvalDataset {
  const stepPolicy = DEFAULT_STEP_EVALUATORS[opts.step]
  const evaluator_parameters: Record<string, unknown> = { deployment_name: opts.judgeDeployment }
  for (const [evaluator, threshold] of Object.entries(stepPolicy.thresholds)) {
    evaluator_parameters[evaluator] = { threshold }
  }
  return {
    name: `sdlc-${opts.step}-gate`,
    evaluators: [...stepPolicy.evaluators],
    data: [
      { query: 'Summarize the key risks in the proposed change.' },
      { query: 'Given the acceptance criteria, does the implementation satisfy them?' },
    ],
    evaluator_parameters,
  }
}

export function renderDatasetJson(dataset: EvalDataset): string {
  return JSON.stringify(dataset, null, 2) + '\n'
}

export function renderPipelineYaml(opts: ScaffoldOptions): string {
  return `# Scaffolded by SDLC Agent Governance — the enforcing CI/PR gate.
# A failing AIAgentEvaluation@2 fails this pipeline. Wire it as a REQUIRED
# branch-policy build on the target branch so a failed gate blocks the PR.
#
# Cost control: this runs only on PRs that touch agent manifests (not every
# commit). For a full nightly sweep, add a 'schedules:' trigger instead.
trigger: none
pr:
  branches:
    include:
      - main
  paths:
    include:
      - '.claude/agents/**'
      - '**/AGENTS.md'
      - '**/agent.yaml'
      - '**/SKILL.md'
      - '.sdlc/eval/dataset.json'

pool:
  vmImage: ubuntu-latest

variables:
  # Define this variable group in Project Settings → Library:
  #   AzureAIProjectEndpoint, DeploymentName, AgentIds (name:version[,name:version])
  - group: sdlc-governance

steps:
  - task: AzureCLI@2
    displayName: 'Authenticate (Entra via ARM service connection)'
    inputs:
      azureSubscription: 'sdlc-foundry-service-connection'
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: 'echo "Authenticated for AI Agent Evaluation"'

  - task: AIAgentEvaluation@2
    displayName: 'Evaluate AI Agents (${opts.step} governance gate)'
    inputs:
      azure-ai-project-endpoint: '$(AzureAIProjectEndpoint)'
      deployment-name: '$(DeploymentName)'
      data-path: '$(System.DefaultWorkingDirectory)/.sdlc/eval/dataset.json'
      agent-ids: '$(AgentIds)'
`
}

export function renderReadme(opts: ScaffoldOptions): string {
  return `# SDLC Agent Governance — Azure DevOps evaluation gate

This folder was scaffolded for the **${opts.step}** SDLC step. The pipeline
\`azure-pipelines-eval-gate.yml\` runs Foundry evaluators on PRs and **blocks the
merge** when a required evaluator fails.

## Operator prerequisites (the extension cannot create these)

1. **Install the marketplace extension** *AI Agent Evaluation* in your Azure
   DevOps organization (provides the \`AIAgentEvaluation@2\` task).
2. **Create an ARM service connection** named \`sdlc-foundry-service-connection\`
   (Project Settings → Service connections → Azure Resource Manager, workload
   identity federation recommended) with at least the **Foundry User** role on
   the Foundry project.
3. **Create a variable group** \`sdlc-governance\` (Project Settings → Library):
   - \`AzureAIProjectEndpoint\` — the Foundry project endpoint
   - \`DeploymentName\` — the judge model deployment (e.g. \`${opts.judgeDeployment}\`)
   - \`AgentIds\` — deployed agents to evaluate, as \`name:version\` (comma-separated)
4. **Make the build required**: Repos → Branches → \`main\` → Branch policies →
   Build validation → add this pipeline as **Required**. *This is what turns a
   failed evaluation into a blocked PR.*

## Agent mapping note

The task evaluates **deployed Foundry agents** (\`name:version\`), while discovery
finds **on-disk manifests**. There is no automatic mapping yet — set \`AgentIds\`
to the deployed agents that correspond to the manifests you govern.

## Cost controls

- The pipeline triggers only on PRs that touch agent manifests, not every commit.
- Keep the dataset small or sample it; prefer a cheaper judge model where quality
  allows.
- Create an **Azure budget** scoped to the Foundry resource group and alert at
  **10–15%** of model-inference spend (the extension's *Scaffold ADO Eval Gate*
  can optionally create this budget for you).
`
}

/** Write the scaffold, confirming before overwriting existing files. */
export async function writeScaffold(
  workspaceRoot: vscode.Uri,
  opts: ScaffoldOptions,
): Promise<WrittenFile[]> {
  const dataset = buildScaffoldDataset(opts)
  const files: Array<{ rel: string; content: string }> = [
    { rel: DATASET_REL, content: renderDatasetJson(dataset) },
    { rel: PIPELINE_REL, content: renderPipelineYaml(opts) },
    { rel: README_REL, content: renderReadme(opts) },
  ]

  const written: WrittenFile[] = []
  for (const f of files) {
    const uri = vscode.Uri.joinPath(workspaceRoot, ...f.rel.split('/'))
    let exists = false
    try {
      await vscode.workspace.fs.stat(uri)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `${f.rel} already exists. Overwrite?`,
        { modal: true },
        'Overwrite',
      )
      if (choice !== 'Overwrite') {
        continue
      }
    }
    // Ensure parent directory exists.
    const dir = vscode.Uri.joinPath(uri, '..')
    await vscode.workspace.fs.createDirectory(dir)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(f.content, 'utf8'))
    written.push({ path: f.rel, uri })
  }
  return written
}
