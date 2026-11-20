'use client'

// One agent's page: its definition (the markdown body of its file) beside the facts that govern it — whether it
// is on for the project, who may use it, where it runs, the tools it may call and the file it comes from.
// Restricted agents are fully readable ("visible, but can't use it"); only the enable switch is locked.

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Bot, FileCode2, FileText, Lock, Pencil, Sparkles } from 'lucide-react'
import { PROJECT_ROLE_LABELS } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function AgentPage({ project, slug }: { project: C.ProjectDetail; slug: string }) {
  const { data: agent, error, loading, setData } = C.useAgent(project.key, slug)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const canConfigure = project.permissions.includes('agent.configure')
  const isSkill = agent?.kind === 'skill'
  const back = `/projects/${encodeURIComponent(project.key)}/${isSkill ? 'skills' : 'agents'}`

  async function toggle(enabled: boolean): Promise<void> {
    if (!agent) return
    setBusy(true)
    try {
      await C.setAgentEnabled(project.key, agent.slug, enabled)
      setData({ ...agent, enabled })
      UI.toast.success(`${agent.name} ${enabled ? 'enabled' : 'disabled'} for ${project.key}`)
    } catch (err) {
      UI.toast.error(err instanceof C.AppError ? err.message : 'Could not change the agent.')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return <UI.ErrorAlert title={error.status === 404 ? 'Agent not found' : 'Could not load the agent'} message={error.message} />
  }
  if (loading || !agent) {
    return (
      <div className="flex flex-col gap-6">
        <UI.Skeleton className="h-12 w-80" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <UI.Skeleton className="h-[480px] rounded-xl" />
          <UI.Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    )
  }

  const lockReason = C.agentLockReason(agent, canConfigure)
  const sourceHref = C.agentSourceHref(project.key, agent)

  return (
    <>
      <div>
        <UI.Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
          <Link href={back}>
            <ArrowLeft /> {isSkill ? 'All skills' : 'All agents'}
          </Link>
        </UI.Button>
      </div>

      <UI.PageHeader
        leading={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            {isSkill ? <Sparkles className="size-5" /> : <Bot className="size-5" />}
          </span>
        }
        title={agent.name}
        badges={<C.AgentBadges agent={agent} />}
        description={agent.description}
        actions={
          sourceHref ? (
            <UI.Button variant="outline" size="sm" asChild>
              <Link href={sourceHref}>
                <FileCode2 /> View source
              </Link>
            </UI.Button>
          ) : agent.source === 'platform' && agent.kind === 'agent' && canConfigure ? (
            <UI.Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Edit agent
            </UI.Button>
          ) : null
        }
      />
      <C.AgentFormSheet
        projectKey={project.key}
        mode={editing ? { type: 'edit', slug: agent.slug } : null}
        onClose={() => setEditing(false)}
        onSaved={(saved) => setData(saved)}
      />

      {agent.issues.length > 0 ? (
        <UI.Alert>
          <AlertTriangle />
          <UI.AlertTitle>Found when importing {agent.sourcePath ?? 'this definition'}</UI.AlertTitle>
          <UI.AlertDescription>
            <ul className="list-disc pl-4">
              {agent.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </UI.AlertDescription>
        </UI.Alert>
      ) : null}

      {!agent.usable && agent.requiredRole ? (
        <UI.Alert>
          <Lock />
          <UI.AlertTitle>You can view this agent but not use it</UI.AlertTitle>
          <UI.AlertDescription>
            {agent.name} is restricted to {PROJECT_ROLE_LABELS[agent.requiredRole].toLowerCase()}s and above (and org admins). You can’t enable it, add it to a
            workflow or run it.
          </UI.AlertDescription>
        </UI.Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <UI.Card>
          <UI.CardHeader>
            <UI.CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4 text-muted-foreground" /> Definition
            </UI.CardTitle>
            {agent.sourcePath ? (
              <UI.CardDescription className="truncate font-mono text-xs" title={agent.sourcePath}>
                {agent.sourcePath}
              </UI.CardDescription>
            ) : null}
          </UI.CardHeader>
          <UI.CardContent>
            {agent.instructions.trim() ? (
              <C.Markdown source={agent.instructions} />
            ) : (
              <p className="text-sm text-muted-foreground">This agent has no written instructions.</p>
            )}
          </UI.CardContent>
        </UI.Card>

        <UI.Card className="lg:sticky lg:top-4">
          <UI.CardHeader>
            <UI.CardTitle className="text-base">Details</UI.CardTitle>
          </UI.CardHeader>
          <UI.CardContent>
            <dl className="flex flex-col gap-4">
              <Fact label={`Enabled for ${project.key}`}>
                <span className="flex items-center gap-2" title={lockReason}>
                  <UI.Switch
                    checked={agent.enabled}
                    disabled={!canConfigure || !agent.usable || busy}
                    onCheckedChange={(on) => void toggle(on)}
                    aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
                  />
                  <span className="text-muted-foreground">{agent.enabled ? 'On' : 'Off'}</span>
                </span>
                {lockReason ? <p className="mt-1 text-xs text-muted-foreground">{lockReason}</p> : null}
              </Fact>
              <UI.Separator />
              <Fact label="Who can use it">
                {agent.requiredRole ? `${PROJECT_ROLE_LABELS[agent.requiredRole]} and above, and org admins` : 'Everyone on the project'}
              </Fact>
              <Fact label="Runs in">
                {agent.executionTarget === 'local' ? 'The developer’s VS Code, against their checkout' : 'The platform server'}
              </Fact>
              {agent.model ? <Fact label="Model">{agent.model}</Fact> : null}
              <Fact label="Category · stage">
                {agent.category} · <span className="capitalize">{agent.sdlcStage}</span>
              </Fact>
              <Fact label="Source">
                {agent.source === 'builtin'
                  ? 'Built-in (ships with the platform)'
                  : agent.source === 'platform'
                    ? 'Platform (defined in this project)'
                    : `Project codebase${agent.branch ? ` · ${agent.branch}` : ''}`}
              </Fact>
              <UI.Separator />
              <Fact label={`Tools (${agent.tools.length})`}>
                {agent.tools.length ? (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {agent.tools.map((t) => (
                      <UI.Badge key={t} variant="outline" className="font-mono text-[10px] font-normal">
                        {t}
                      </UI.Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">None — this agent can only reason over what it is given.</span>
                )}
              </Fact>
            </dl>
          </UI.CardContent>
        </UI.Card>
      </div>
    </>
  )
}

export default function AgentDetailContainer() {
  const { slug } = useParams<{ slug: string }>()
  return <C.ProjectShell header={false}>{(project) => <AgentPage project={project} slug={decodeURIComponent(slug)} />}</C.ProjectShell>
}
