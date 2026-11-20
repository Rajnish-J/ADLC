'use client'

// Project settings → Agents & skills: every workflow of the project, one card each, with every agent step's agent,
// skills and harness mappable in place (each change saves straight away). A search and "only unassigned" work
// across all of them, and each card says how many of its steps still need an agent. The steps themselves are
// changed in the workflow editor.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronRight, Pencil, Search, Workflow as WorkflowIcon } from 'lucide-react'
import type { Agent } from '@sdlc/contracts'
import type { SpecNode } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'

/** An agent step that can't run as it is: no agent, or one that is gone, off for the project or not usable. */
function needsAgent(node: SpecNode, bySlug: Map<string, Agent>): boolean {
  if (node.kind !== 'agent') return false
  const slug = node.data.agentId
  if (!slug) return true
  const agent = bySlug.get(slug)
  return !!agent && (!agent.enabled || !agent.usable || agent.kind !== 'agent')
}

export default function AgentMappingSection({ project }: { project: C.ProjectDetail }) {
  const { data: workflows, error, loading, setData } = C.useWorkflowDetails(project.key)
  const { data: catalog } = C.useAgents(project.key)
  const [search, setSearch] = useState('')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const canEdit = project.permissions.includes('workflow.edit')
  const base = `/projects/${encodeURIComponent(project.key)}/workflow`

  const bySlug = useMemo(() => new Map((catalog ?? []).map((a) => [a.slug, a])), [catalog])
  const q = search.trim().toLowerCase()
  const filter = useMemo(() => {
    if (!q && !onlyUnassigned) return undefined
    return (n: SpecNode): boolean => {
      if (onlyUnassigned && !needsAgent(n, bySlug)) return false
      if (!q) return true
      const agentName = (n.data.agentId && bySlug.get(n.data.agentId)?.name) || n.data.agentName || ''
      return `${n.label} ${agentName} ${n.data.agentId ?? ''} ${(n.data.skills ?? []).join(' ')}`.toLowerCase().includes(q)
    }
  }, [q, onlyUnassigned, bySlug])

  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading || !workflows) {
    return (
      <>
        <UI.Skeleton className="h-10 rounded-lg" />
        <UI.Skeleton className="h-64 rounded-xl" />
        <UI.Skeleton className="h-40 rounded-xl" />
      </>
    )
  }
  if (workflows.length === 0) {
    return <UI.EmptyState icon={<WorkflowIcon />} title="No workflows yet" description="Create one on the Workflow page, then map its steps here." />
  }

  const stats = workflows.map((w) => {
    const steps = w.spec.nodes.filter((n) => n.kind === 'agent')
    return { id: w.id, steps: steps.length, unassigned: steps.filter((n) => needsAgent(n, bySlug)).length, shown: filter ? steps.filter(filter).length : steps.length }
  })
  const totalSteps = stats.reduce((n, s) => n + s.steps, 0)
  const totalUnassigned = stats.reduce((n, s) => n + s.unassigned, 0)
  const anyShown = stats.some((s) => s.shown > 0)
  // A search or filter shows every card it matches; otherwise cards stay as the person left them.
  const isOpen = (id: string): boolean => !collapsed.has(id) || !!filter

  function replace(updated: C.WorkflowDetail): void {
    setData((workflows ?? []).map((w) => (w.id === updated.id ? { ...w, ...updated } : w)))
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {workflows.length} workflow{workflows.length === 1 ? '' : 's'} · {totalSteps} agent step{totalSteps === 1 ? '' : 's'}
          {totalUnassigned ? (
            <span className="text-warning-foreground dark:text-warning"> · {totalUnassigned} need{totalUnassigned === 1 ? 's' : ''} an agent</span>
          ) : (
            ' · every step has an agent'
          )}
          {canEdit ? '. Changes save straight away and apply to runs started from now on.' : '. Leads and owners can change the mapping.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <UI.InputGroup className="w-full sm:w-72">
            <UI.InputGroupAddon>
              <Search />
            </UI.InputGroupAddon>
            <UI.InputGroupInput placeholder="Search steps, agents or skills…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search steps" />
          </UI.InputGroup>
          <UI.Field orientation="horizontal" className="w-auto">
            <UI.Switch id="only-unassigned" checked={onlyUnassigned} onCheckedChange={setOnlyUnassigned} />
            <UI.FieldLabel htmlFor="only-unassigned" className="font-normal">
              Only steps that need an agent
            </UI.FieldLabel>
          </UI.Field>
          <span className="flex gap-1 sm:ml-auto">
            <UI.Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())}>
              Expand all
            </UI.Button>
            <UI.Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set(stats.filter((s) => s.unassigned === 0).map((s) => s.id)))}
              title="Workflows with steps that need an agent stay open">
              Collapse all
            </UI.Button>
          </span>
        </div>
      </div>

      {!anyShown && filter ? (
        <UI.EmptyState
          icon={<Search />}
          title={onlyUnassigned && !q ? 'Every step has an agent' : 'No step matches'}
          description={onlyUnassigned && !q ? 'Nothing needs mapping in any workflow.' : 'Try another search.'}
        />
      ) : null}

      {workflows.map((w) => {
        const s = stats.find((x) => x.id === w.id)!
        if (filter && s.shown === 0) return null
        const open = isOpen(w.id)
        return (
          <UI.Collapsible
            key={w.id}
            open={open}
            onOpenChange={(next) =>
              setCollapsed((prev) => {
                const copy = new Set(prev)
                if (next) copy.delete(w.id)
                else copy.add(w.id)
                return copy
              })
            }
            asChild
          >
            <UI.Card className="gap-0 overflow-hidden py-0">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <UI.CollapsibleTrigger asChild>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={`${open ? 'Collapse' : 'Expand'} ${w.name}`}>
                    <ChevronRight className={UI.cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                    <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{w.name}</span>
                    {w.isDefault ? <UI.Badge variant="secondary">Default</UI.Badge> : null}
                    <span className="text-xs text-muted-foreground">
                      {s.steps} agent step{s.steps === 1 ? '' : 's'}
                    </span>
                    {s.unassigned ? (
                      <UI.Badge variant="warning">
                        <AlertTriangle /> {s.unassigned} need{s.unassigned === 1 ? 's' : ''} an agent
                      </UI.Badge>
                    ) : null}
                  </button>
                </UI.CollapsibleTrigger>
                <UI.Button variant="ghost" size="sm" asChild>
                  <Link href={`${base}/${w.id}/edit`}>
                    <Pencil /> {canEdit ? 'Edit steps' : 'Open'}
                  </Link>
                </UI.Button>
              </div>
              <UI.CollapsibleContent>
                <div className="border-t">
                  {s.steps === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">
                      No agent steps.{' '}
                      {canEdit ? (
                        <Link href={`${base}/${w.id}/edit`} className="text-primary hover:underline">
                          Add some in the editor
                        </Link>
                      ) : null}
                    </p>
                  ) : (
                    <C.StepMapping project={project} workflow={w} onChanged={replace} catalog={catalog} filter={filter} embedded />
                  )}
                </div>
              </UI.CollapsibleContent>
            </UI.Card>
          </UI.Collapsible>
        )
      })}
    </>
  )
}
