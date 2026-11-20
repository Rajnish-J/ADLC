'use client'

// Project settings → Memory: what the platform remembers on its own for this project (run summaries, learnings
// from failed gates and rejected plans, a proposal when a story is done), whether a quick fix's memory waits for a
// lead, and whether — and how much — memory runs are given. Owners and leads change it; everyone can read it.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Brain } from 'lucide-react'
import {
  MEMORY_CONTEXT_BUDGET,
  ProjectMemorySettingsSchema,
  readProjectSettings,
  type ProjectMemorySettings,
  type QuickFixMemoryPolicy,
} from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import { useProjectMemory } from '@/hooks/memory/useMemory'
import AiContextCard from './AiContextCard'

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (on: boolean) => void
  disabled: boolean
}) {
  return (
    <UI.Field orientation="horizontal">
      <UI.FieldContent>
        <UI.FieldLabel htmlFor={id}>{label}</UI.FieldLabel>
        <UI.FieldDescription>{hint}</UI.FieldDescription>
      </UI.FieldContent>
      <UI.Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </UI.Field>
  )
}

function MemoryOverview({ projectKey }: { projectKey: string }) {
  const { data: items } = useProjectMemory(projectKey)
  const count = (status: string): number => (items ?? []).filter((i) => i.status === status).length
  const stats: UI.StatItem[] = [
    { label: 'Accepted', value: items ? count('accepted') : '—', footer: { title: 'Project memory runs can be given' } },
    { label: 'Awaiting review', value: items ? count('proposed') : '—', footer: { title: 'Proposed by runs and finished stories' } },
    { label: 'Rejected or archived', value: items ? count('rejected') + count('archived') : '—', footer: { title: 'Never given to runs' } },
  ]
  return <UI.StatCards items={stats} />
}

export default function MemorySettingsSection({ project, onSaved }: { project: ST.ProjectDetail; onSaved: (p: ST.ProjectDetail) => void }) {
  const stored = readProjectSettings(project.settings).memory
  const [memory, setMemory] = useState<ProjectMemorySettings>(stored)
  const [saving, setSaving] = useState(false)
  const canEdit = project.permissions.includes('project.update')
  const storedKey = JSON.stringify(stored)
  useEffect(() => setMemory(JSON.parse(storedKey) as ProjectMemorySettings), [storedKey])

  const dirty = JSON.stringify(memory) !== storedKey
  const valid = ProjectMemorySettingsSchema.safeParse(memory).success
  const set = <K extends keyof ProjectMemorySettings>(key: K, value: ProjectMemorySettings[K]): void => setMemory((m) => ({ ...m, [key]: value }))

  async function save(): Promise<void> {
    setSaving(true)
    try {
      onSaved(await ST.updateProject(project.key, { settings: { memory } }))
      UI.toast.success('Memory settings saved')
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not save the memory settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <MemoryOverview projectKey={project.key} />

      <UI.Card className="gap-0 py-0">
        <UI.CardHeader className="border-b py-4">
          <UI.CardTitle>What the platform remembers</UI.CardTitle>
          <UI.CardDescription>
            Memory recorded automatically as work happens. People can always add memory by hand on the{' '}
            <Link href={`/projects/${encodeURIComponent(project.key)}/memory`} className="text-primary hover:underline">
              Memory page
            </Link>
            .{canEdit ? '' : ' Owners and leads can change these settings.'}
          </UI.CardDescription>
          {canEdit ? (
            <UI.CardAction className="flex gap-2">
              <UI.Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setMemory(stored)}>
                Reset
              </UI.Button>
              <UI.Button size="sm" disabled={!dirty || !valid || saving} onClick={() => void save()}>
                {saving ? <UI.Spinner /> : null} Save
              </UI.Button>
            </UI.CardAction>
          ) : null}
        </UI.CardHeader>
        <UI.CardContent className="py-4">
          <UI.FieldGroup className="gap-5">
            <Toggle
              id="mem-summaries"
              label="Summarise every completed run"
              hint="The prompt, what the last agent reported and the files it changed. A story run’s summary goes to the story’s memory."
              checked={memory.captureRunSummaries}
              onChange={(on) => set('captureRunSummaries', on)}
              disabled={!canEdit}
            />
            <Toggle
              id="mem-learnings"
              label="Record learnings from failures"
              hint="When a quality gate fails, or a plan is rejected with a comment, the reason is kept so later runs avoid it."
              checked={memory.captureLearnings}
              onChange={(on) => set('captureLearnings', on)}
              disabled={!canEdit}
            />
            <Toggle
              id="mem-story-done"
              label="Propose a summary when a story is done"
              hint="Rolls the story’s criteria, commits, runs and decisions up into a project-memory proposal for a lead to accept."
              checked={memory.proposeOnStoryDone}
              onChange={(on) => set('proposeOnStoryDone', on)}
              disabled={!canEdit}
            />
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="mem-quick-fix">Quick-fix memory</UI.FieldLabel>
                <UI.FieldDescription>A quick fix has no story, so what it records goes straight to project memory.</UI.FieldDescription>
              </UI.FieldContent>
              <UI.Select value={memory.quickFixMemory} onValueChange={(v) => set('quickFixMemory', v as QuickFixMemoryPolicy)} disabled={!canEdit}>
                <UI.SelectTrigger id="mem-quick-fix" className="w-48">
                  <UI.SelectValue />
                </UI.SelectTrigger>
                <UI.SelectContent>
                  <UI.SelectItem value="propose">A lead approves it</UI.SelectItem>
                  <UI.SelectItem value="accept">Accept automatically</UI.SelectItem>
                </UI.SelectContent>
              </UI.Select>
            </UI.Field>
          </UI.FieldGroup>
        </UI.CardContent>
      </UI.Card>

      <UI.Card className="gap-0 py-0">
        <UI.CardHeader className="border-b py-4">
          <UI.CardTitle className="flex items-center gap-2">
            <Brain className="size-4 text-muted-foreground" /> What runs are given
          </UI.CardTitle>
          <UI.CardDescription>
            Before an agent starts, the harness gets the story’s memory, pinned knowledge, the project’s conventions and decisions, and the items most
            related to the work.
          </UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent className="py-4">
          <UI.FieldGroup className="gap-5">
            <Toggle
              id="mem-provide"
              label="Give memory to runs"
              hint="Off: agents start without the project’s memory (it is still recorded and kept)."
              checked={memory.provideToRuns}
              onChange={(on) => set('provideToRuns', on)}
              disabled={!canEdit}
            />
            <UI.Field data-invalid={!valid}>
              <UI.FieldLabel htmlFor="mem-budget">How much memory a run gets</UI.FieldLabel>
              <div className="flex items-center gap-2">
                <UI.Input
                  id="mem-budget"
                  type="number"
                  step={1000}
                  min={MEMORY_CONTEXT_BUDGET.min}
                  max={MEMORY_CONTEXT_BUDGET.max}
                  value={memory.contextBudget}
                  onChange={(e) => set('contextBudget', Number(e.target.value) || 0)}
                  disabled={!canEdit || !memory.provideToRuns}
                  className="w-32"
                  aria-invalid={!valid}
                />
                <span className="text-sm text-muted-foreground">characters (about {Math.round(memory.contextBudget / 4).toLocaleString()} tokens)</span>
              </div>
              <UI.FieldDescription>
                Between {MEMORY_CONTEXT_BUDGET.min.toLocaleString()} and {MEMORY_CONTEXT_BUDGET.max.toLocaleString()}. More gives agents more context but crowds the
                prompt.
              </UI.FieldDescription>
            </UI.Field>
          </UI.FieldGroup>
        </UI.CardContent>
      </UI.Card>

      <AiContextCard project={project} onSaved={onSaved} />
    </>
  )
}
