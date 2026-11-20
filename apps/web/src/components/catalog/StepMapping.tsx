'use client'

// Which agent (and which skills) run each agent step of the selected workflow, and optionally the harness it runs in.
// Leads and owners pick from the project's enabled agents they may use and the harnesses the project allows; everyone
// else sees the mapping read-only. The API re-checks all of it.

import { useState } from 'react'
import Link from 'next/link'
import { Bot } from 'lucide-react'
import { harnessLabel, KNOWN_HARNESSES, readProjectSettings, type Agent, type ProjectDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { useAgents } from '@/hooks/catalog/useCatalog'
import { setStepAgent, setStepHarness } from '@/service/catalog.service'
import type { SpecNode } from '@sdlc/core'
import type { WorkflowDetail } from '@/types/workflow/workflow.types'
import { agentHref } from './AgentRow'
import StepSkills from './StepSkills'

const NONE = '__none'
/** The step runs in whichever harness the run is started with. */
const RUN_DEFAULT = '__default'

const mappable = (a: Agent): boolean => a.kind === 'agent' && a.enabled && a.usable

export default function StepMapping({
  project,
  workflow,
  onChanged,
  catalog,
  filter,
  embedded,
}: {
  project: ProjectDetail
  workflow: WorkflowDetail
  onChanged: (workflow: WorkflowDetail) => void
  /** The project's agents and skills, when the caller already loaded them (several workflows on one page). */
  catalog?: Agent[] | null
  /** Show only the agent steps this keeps (search, "only unassigned"). */
  filter?: (node: SpecNode) => boolean
  /** Inside the caller's own card: no card or header of its own. */
  embedded?: boolean
}) {
  const own = useAgents(project.key)
  const agents = catalog !== undefined ? catalog : own.data
  const [busy, setBusy] = useState<string | null>(null)
  const canEdit = project.permissions.includes('workflow.edit')
  const allSteps = workflow.spec.nodes.filter((n) => n.kind === 'agent')
  const steps = filter ? allSteps.filter(filter) : allSteps
  if (allSteps.length === 0) return null
  if (steps.length === 0) return embedded ? <p className="px-4 py-3 text-sm text-muted-foreground">No step here matches.</p> : null

  const options = (agents ?? []).filter(mappable)
  const bySlug = new Map((agents ?? []).map((a) => [a.slug, a]))
  const allowedHarnesses = readProjectSettings(project.settings).allowedEngines
  const harnessOptions = allowedHarnesses.length ? allowedHarnesses : KNOWN_HARNESSES.map((h) => h.id)

  async function change(nodeId: string, value: string): Promise<void> {
    const agentSlug = value === NONE ? null : value
    setBusy(nodeId)
    try {
      const res = await setStepAgent(project.key, workflow.id, nodeId, agentSlug)
      onChanged({
        ...workflow,
        version: res.version,
        spec: {
          ...workflow.spec,
          nodes: workflow.spec.nodes.map((n) => {
            if (n.id !== nodeId) return n
            const { agentId: _id, agentName: _name, ...rest } = n.data
            return { ...n, data: res.agentSlug ? { ...rest, agentId: res.agentSlug, agentName: res.agentName ?? res.agentSlug } : rest }
          }),
        },
      })
      const step = steps.find((s) => s.id === nodeId)?.label ?? 'Step'
      UI.toast.success(res.agentName ? `${step} now runs ${res.agentName}` : `${step} has no agent`)
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not change the step’s agent.')
    } finally {
      setBusy(null)
    }
  }

  async function changeHarness(nodeId: string, value: string): Promise<void> {
    const harness = value === RUN_DEFAULT ? null : value
    setBusy(`harness:${nodeId}`)
    try {
      const res = await setStepHarness(project.key, workflow.id, nodeId, harness)
      onChanged({
        ...workflow,
        version: res.version,
        spec: {
          ...workflow.spec,
          nodes: workflow.spec.nodes.map((n) => {
            if (n.id !== nodeId) return n
            const { harness: _h, ...rest } = n.data
            return { ...n, data: res.harness ? { ...rest, harness: res.harness } : rest }
          }),
        },
      })
      const step = steps.find((s) => s.id === nodeId)?.label ?? 'Step'
      UI.toast.success(res.harness ? `${step} now runs in ${harnessLabel(res.harness)}` : `${step} runs in the harness picked at start`)
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not change the step’s harness.')
    } finally {
      setBusy(null)
    }
  }

  const list = (
    <UI.ItemGroup>
      {steps.map((step, i) => {
        const slug = step.data.agentId
        const current = slug ? bySlug.get(slug) : undefined
        const name = current?.name ?? step.data.agentName ?? slug
        const pinned = step.data.harness
        return (
          <div key={step.id}>
            {i > 0 ? <UI.ItemSeparator /> : null}
            <UI.Item size="sm" className="rounded-none border-0 px-4">
              <UI.ItemMedia variant="icon">
                <Bot />
              </UI.ItemMedia>
              <UI.ItemContent>
                <UI.ItemTitle>{step.label}</UI.ItemTitle>
                <UI.ItemDescription>
                  {!slug ? (
                    <span className="text-warning-foreground italic dark:text-warning">No agent assigned yet</span>
                  ) : current && !current.enabled ? (
                    <span className="text-warning-foreground dark:text-warning">{name} is disabled in this project</span>
                  ) : (
                    <Link href={agentHref(project.key, slug)} className="hover:text-primary hover:underline">
                      {current?.description ?? name}
                    </Link>
                  )}
                </UI.ItemDescription>
                <StepSkills
                  projectKey={project.key}
                  workflowId={workflow.id}
                  nodeId={step.id}
                  stepLabel={step.label}
                  value={Array.isArray(step.data.skills) ? step.data.skills : []}
                  skills={agents ?? []}
                  canEdit={canEdit}
                  onChanged={(skills, version) =>
                    onChanged({
                      ...workflow,
                      version,
                      spec: {
                        ...workflow.spec,
                        nodes: workflow.spec.nodes.map((n) => {
                          if (n.id !== step.id) return n
                          const { skills: _s, ...rest } = n.data
                          return { ...n, data: skills.length ? { ...rest, skills } : rest }
                        }),
                      },
                    })
                  }
                />
              </UI.ItemContent>
              <UI.ItemActions className="flex-wrap justify-end">
                {canEdit ? (
                  <UI.Select value={slug ?? NONE} onValueChange={(v) => void change(step.id, v)} disabled={busy !== null || !agents}>
                    <UI.SelectTrigger className="w-52" aria-label={`Agent for ${step.label}`}>
                      {busy === step.id ? <UI.Spinner className="size-3" /> : null}
                      <UI.SelectValue placeholder="Choose an agent" />
                    </UI.SelectTrigger>
                    <UI.SelectContent>
                      <UI.SelectItem value={NONE}>No agent</UI.SelectItem>
                      {slug && !options.some((a) => a.slug === slug) ? (
                        <UI.SelectItem value={slug} disabled>
                          {name}
                        </UI.SelectItem>
                      ) : null}
                      {options.map((a) => (
                        <UI.SelectItem key={a.slug} value={a.slug}>
                          {a.name}
                          {a.source === 'repo' ? <span className="text-xs text-muted-foreground"> · codebase</span> : null}
                        </UI.SelectItem>
                      ))}
                    </UI.SelectContent>
                  </UI.Select>
                ) : (
                  <UI.Badge variant={slug ? 'secondary' : 'outline'}>{slug ? name : 'Unassigned'}</UI.Badge>
                )}
                {canEdit ? (
                  <UI.Select value={pinned ?? RUN_DEFAULT} onValueChange={(v) => void changeHarness(step.id, v)} disabled={busy !== null}>
                    <UI.SelectTrigger className="w-44" aria-label={`Harness for ${step.label}`}>
                      {busy === `harness:${step.id}` ? <UI.Spinner className="size-3" /> : null}
                      <UI.SelectValue>{pinned ? harnessLabel(pinned) : 'Run default'}</UI.SelectValue>
                    </UI.SelectTrigger>
                    <UI.SelectContent>
                      <UI.SelectItem value={RUN_DEFAULT}>
                        <span className="flex flex-col">
                          Run default
                          <span className="text-xs text-muted-foreground">The harness picked when the run starts</span>
                        </span>
                      </UI.SelectItem>
                      {pinned && !harnessOptions.includes(pinned) ? (
                        <UI.SelectItem value={pinned} disabled>
                          {harnessLabel(pinned)} (not allowed)
                        </UI.SelectItem>
                      ) : null}
                      {harnessOptions.map((id) => (
                        <UI.SelectItem key={id} value={id}>
                          {harnessLabel(id)}
                        </UI.SelectItem>
                      ))}
                    </UI.SelectContent>
                  </UI.Select>
                ) : pinned ? (
                  <UI.Badge variant="outline" title="Runs in this harness whichever one the run starts with">
                    {harnessLabel(pinned)}
                  </UI.Badge>
                ) : null}
              </UI.ItemActions>
            </UI.Item>
          </div>
        )
      })}
    </UI.ItemGroup>
  )
  if (embedded) return list

  return (
    <UI.Card className="gap-0 py-0">
      <UI.CardHeader className="border-b py-4">
        <UI.CardTitle>Agent and skill mapping</UI.CardTitle>
        <UI.CardDescription>
          {canEdit
            ? 'Choose which agent runs each step, the skills it may use and, if it needs one, its harness. Only agents and skills enabled for this project are offered.'
            : 'Which agent runs each step, its skills and harness. Leads and owners can change this.'}
        </UI.CardDescription>
      </UI.CardHeader>
      {list}
    </UI.Card>
  )
}
