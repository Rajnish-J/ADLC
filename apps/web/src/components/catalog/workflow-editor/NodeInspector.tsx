'use client'

// The side panel for what is selected on the canvas: one step's settings (its agent, skills and harness for an
// agent step; the question for an approval; the predicate for a condition…), a selected connection, several
// steps at once, or — with nothing selected — the workflow's own settings.

import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, CircleAlert, ExternalLink, Info, Pencil, Plus, Trash2 } from 'lucide-react'
import { harnessLabel, type Agent } from '@sdlc/contracts'
import { deletableNodeIds, SDLC_STEPS, STEP_LABELS, type SpecNodeData } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import { AgentBadges, agentHref } from '../AgentRow'
import { KIND_STYLE } from '../WorkflowNodeCard'
import { AgentCombobox } from '../pickers/AgentCombobox'
import { SkillsMultiSelect } from '../pickers/SkillsMultiSelect'
import type { EditorNode, StepIssue } from './editorModel'
import type { WorkflowEditorState } from './useWorkflowEditor'

const NONE = '__none'

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b p-4 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  mono,
  disabled,
}: {
  id: string
  label: string
  value: string | undefined
  onChange: (v: string) => void
  placeholder?: string
  hint?: ReactNode
  multiline?: boolean
  mono?: boolean
  disabled?: boolean
}) {
  return (
    <UI.Field>
      <UI.FieldLabel htmlFor={id}>{label}</UI.FieldLabel>
      {multiline ? (
        <UI.Textarea id={id} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className={UI.cn(mono && 'font-mono text-xs')} />
      ) : (
        <UI.Input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className={UI.cn(mono && 'font-mono text-xs')} />
      )}
      {hint ? <UI.FieldDescription>{hint}</UI.FieldDescription> : null}
    </UI.Field>
  )
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  noneLabel,
  hint,
  disabled,
}: {
  id: string
  label: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  options: Array<{ value: string; label: string }>
  noneLabel?: string
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <UI.Field>
      <UI.FieldLabel htmlFor={id}>{label}</UI.FieldLabel>
      <UI.Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)} disabled={disabled}>
        <UI.SelectTrigger id={id} className="w-full">
          <UI.SelectValue />
        </UI.SelectTrigger>
        <UI.SelectContent>
          {noneLabel ? <UI.SelectItem value={NONE}>{noneLabel}</UI.SelectItem> : null}
          {value && !options.some((o) => o.value === value) ? (
            <UI.SelectItem value={value} disabled>
              {value}
            </UI.SelectItem>
          ) : null}
          {options.map((o) => (
            <UI.SelectItem key={o.value} value={o.value}>
              {o.label}
            </UI.SelectItem>
          ))}
        </UI.SelectContent>
      </UI.Select>
      {hint ? <UI.FieldDescription>{hint}</UI.FieldDescription> : null}
    </UI.Field>
  )
}

function IssueList({ issues }: { issues: StepIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((i) => (
        <li key={i.message} className={UI.cn('flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs', i.level === 'error' ? 'border-destructive/40 text-destructive' : 'text-warning-foreground dark:text-warning')}>
          {i.level === 'error' ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
          {i.message}
        </li>
      ))}
    </ul>
  )
}

const SDLC_OPTIONS = SDLC_STEPS.map((s) => ({ value: s, label: STEP_LABELS[s] }))

interface InspectorProps {
  editor: WorkflowEditorState
  projectKey: string
  catalog: Agent[] | null
  harnessOptions: readonly string[]
  readOnly: boolean
  canConfigureAgents: boolean
  onNewAgent: (nodeId: string) => void
  onEditAgent: (slug: string) => void
}

function StepPanel({ node, editor, projectKey, catalog, harnessOptions, readOnly, canConfigureAgents, onNewAgent, onEditAgent }: InspectorProps & { node: EditorNode }) {
  const d = node.data.specData
  const id = node.id
  const set = (data: Partial<SpecNodeData>): void => editor.updateStep(id, { data })
  const style = KIND_STYLE[node.data.kind]
  const issues = editor.issues.filter((i) => i.nodeId === id)
  const canDelete = deletableNodeIds(editor.nodes, [id]).length > 0
  const agent = d.agentId ? catalog?.find((a) => a.slug === d.agentId) : undefined
  const f = (name: string): string => `step-${id}-${name}`

  return (
    <>
      <Section title={style.label} actions={<code className="truncate text-[10px] text-muted-foreground" title="Step id (fixed)">{id}</code>}>
        <TextField id={f('label')} label="Name" value={node.data.label} onChange={(label) => editor.updateStep(id, { label })} disabled={readOnly} />
        <IssueList issues={issues} />
      </Section>

      {node.data.kind === 'agent' ? (
        <>
          <Section
            title="Agent"
            actions={
              canConfigureAgents && !readOnly ? (
                <UI.Button variant="ghost" size="xs" onClick={() => onNewAgent(id)}>
                  <Plus /> New agent
                </UI.Button>
              ) : null
            }
          >
            <AgentCombobox catalog={catalog ?? []} value={d.agentId} fallbackName={d.agentName} onChange={(next) => editor.mapAgent(id, next)} disabled={readOnly || !catalog} />
            {agent ? (
              <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
                <p className="line-clamp-3 text-xs text-muted-foreground">{agent.description}</p>
                <div className="flex flex-wrap gap-1">
                  <AgentBadges agent={agent} />
                </div>
                <div className="flex flex-wrap gap-1">
                  <UI.Button variant="outline" size="xs" asChild>
                    <Link href={agentHref(projectKey, agent.slug)} target="_blank">
                      <ExternalLink /> Open
                    </Link>
                  </UI.Button>
                  {agent.source === 'platform' && canConfigureAgents && !readOnly ? (
                    <UI.Button variant="outline" size="xs" onClick={() => onEditAgent(agent.slug)}>
                      <Pencil /> Edit agent
                    </UI.Button>
                  ) : null}
                </div>
                {agent.source !== 'platform' ? (
                  <p className="text-[11px] text-muted-foreground">{agent.source === 'repo' ? 'Defined in the repository — edit it there.' : 'Built in — read-only.'}</p>
                ) : null}
              </div>
            ) : null}
          </Section>
          <Section title="Skills">
            <SkillsMultiSelect catalog={catalog ?? []} value={d.skills ?? []} onChange={(skills) => set({ skills })} canEdit={!readOnly} label={node.data.label} removable />
            {!readOnly && !(d.skills ?? []).length ? <p className="text-xs text-muted-foreground">Optional capabilities the agent may load on this step.</p> : null}
          </Section>
          <Section title="Approval">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <UI.Label htmlFor={f('plan')} className="text-sm">
                  Require plan approval
                </UI.Label>
                <p className="text-xs text-muted-foreground">
                  {d.requirePlanApproval === false
                    ? 'The agent executes straight away.'
                    : 'The agent submits a plan first and waits for a person to approve it.'}
                </p>
              </div>
              <UI.Switch
                id={f('plan')}
                checked={d.requirePlanApproval !== false}
                onCheckedChange={(on) => set({ requirePlanApproval: on ? undefined : false })}
                disabled={readOnly}
              />
            </div>
          </Section>
          <Section title="Runs in">
            <SelectField
              id={f('harness')}
              label="Harness"
              value={d.harness}
              onChange={(harness) => set({ harness })}
              noneLabel="Run default"
              options={harnessOptions.map((h) => ({ value: h, label: harnessLabel(h) }))}
              hint={d.harness ? 'This step always runs in this harness.' : 'The harness picked when the run starts.'}
              disabled={readOnly}
            />
            <SelectField id={f('sdlc')} label="SDLC step" value={d.sdlcStep} onChange={(v) => set({ sdlcStep: v as SpecNodeData['sdlcStep'] })} noneLabel="None" options={SDLC_OPTIONS} disabled={readOnly} />
            <TextField id={f('out')} label="Output variable" value={d.outputVar} onChange={(outputVar) => set({ outputVar })} placeholder="Local.Result" mono hint="Stores the step’s summary for later steps." disabled={readOnly} />
          </Section>
        </>
      ) : null}

      {node.data.kind === 'trigger' ? (
        <Section title="Starts from">
          <SelectField
            id={f('trigger')}
            label="Run input"
            value={d.triggerType ?? 'manual'}
            onChange={(v) => set({ triggerType: v as SpecNodeData['triggerType'] })}
            options={[
              { value: 'manual', label: 'A story or a free-text prompt' },
              { value: 'issue', label: 'An Azure DevOps work item' },
            ]}
            disabled={readOnly}
          />
          {d.triggerType === 'issue' ? (
            <>
              <TextField id={f('org')} label="Organization" value={d.adoOrg} onChange={(adoOrg) => set({ adoOrg })} placeholder="From settings" disabled={readOnly} />
              <TextField id={f('proj')} label="Project" value={d.adoProject} onChange={(adoProject) => set({ adoProject })} placeholder="From settings" disabled={readOnly} />
              <TextField id={f('wit')} label="Work item type" value={d.workItemType} onChange={(workItemType) => set({ workItemType })} placeholder="User Story" disabled={readOnly} />
              <TextField id={f('wiql')} label="WIQL override" value={d.wiql} onChange={(wiql) => set({ wiql })} placeholder="SELECT [System.Id] FROM WorkItems WHERE …" multiline mono disabled={readOnly} />
            </>
          ) : null}
        </Section>
      ) : null}

      {node.data.kind === 'gate' ? (
        <Section title="Gate">
          <SelectField id={f('gate')} label="Evaluates" value={d.gateStep} onChange={(v) => set({ gateStep: v as SpecNodeData['gateStep'] })} noneLabel="Implement (default)" options={SDLC_OPTIONS} hint="Runs this SDLC step’s evaluators; a failure stops the run." disabled={readOnly} />
          <TextField id={f('gvar')} label="Result variable" value={d.gateResultVar} onChange={(gateResultVar) => set({ gateResultVar })} placeholder="Local.GateResult" mono disabled={readOnly} />
        </Section>
      ) : null}

      {node.data.kind === 'approval' ? (
        <Section title="Approval">
          <TextField id={f('q')} label="Question" value={d.question} onChange={(question) => set({ question })} placeholder="Approve to continue?" multiline disabled={readOnly} />
          <TextField id={f('avar')} label="Answer variable" value={d.approvalVar} onChange={(approvalVar) => set({ approvalVar })} placeholder="Local.Approval" mono disabled={readOnly} />
          <TextField id={f('adef')} label="Suggested answer" value={d.approvalDefault} onChange={(approvalDefault) => set({ approvalDefault })} disabled={readOnly} />
        </Section>
      ) : null}

      {node.data.kind === 'condition' ? (
        <Section title="Condition">
          <SelectField
            id={f('branch')}
            label="Branch"
            value={d.branch ?? 'IF'}
            onChange={(v) => set({ branch: (v ?? 'IF') as SpecNodeData['branch'] })}
            options={[
              { value: 'IF', label: 'If' },
              { value: 'ELSE_IF', label: 'Else if' },
              { value: 'ELSE', label: 'Else' },
            ]}
            hint="Sibling conditions are tried If → Else if → Else; the first that holds is taken."
            disabled={readOnly}
          />
          {d.branch !== 'ELSE' ? (
            <TextField
              id={f('pred')}
              label="Predicate"
              value={d.predicate}
              onChange={(predicate) => set({ predicate })}
              placeholder='Local.Kind = "FEATURE" And Local.Count >= 2'
              multiline
              mono
              hint={
                <>
                  Compare with <code>=</code> <code>&lt;&gt;</code> <code>&gt;=</code> <code>&lt;</code>…, combine with <code>And</code> / <code>Or</code>. There is no{' '}
                  <code>Not()</code>, and don’t start a comparison with <code>=</code>. Empty always holds.
                </>
              }
              disabled={readOnly}
            />
          ) : null}
        </Section>
      ) : null}

      {node.data.kind === 'set-variable' ? (
        <Section title="Set variable">
          <TextField id={f('var')} label="Variable" value={d.variable} onChange={(variable) => set({ variable })} placeholder="Local.Attempts" mono disabled={readOnly} />
          <TextField id={f('val')} label="Value" value={d.value} onChange={(value) => set({ value })} placeholder="=Local.Attempts + 1" mono disabled={readOnly} />
        </Section>
      ) : null}

      {node.data.kind === 'goto' ? (
        <Section title="Go to">
          <SelectField
            id={f('target')}
            label="Target step"
            value={d.targetId}
            onChange={(targetId) => set({ targetId })}
            noneLabel="Choose a step"
            options={editor.nodes.filter((n) => n.id !== id && n.data.kind !== 'trigger').map((n) => ({ value: n.id, label: n.data.label || n.id }))}
            hint="The run continues from that step. The run budget caps how often it can loop."
            disabled={readOnly}
          />
        </Section>
      ) : null}

      {!readOnly ? (
        <div className="p-4">
          <UI.Button variant="outline" size="sm" className="w-full text-destructive hover:text-destructive" disabled={!canDelete} onClick={() => editor.deleteElements([id])}>
            <Trash2 /> Delete step
          </UI.Button>
          {!canDelete ? (
            <p className="mt-2 text-center text-xs text-muted-foreground">{node.data.kind === 'trigger' ? 'Every workflow has one start step.' : 'A workflow needs at least one end step.'}</p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function WorkflowPanel({ editor, readOnly }: { editor: WorkflowEditorState; readOnly: boolean }) {
  const counts = editor.spec.nodes.reduce<Record<string, number>>((m, n) => ({ ...m, [n.kind]: (m[n.kind] ?? 0) + 1 }), {})
  return (
    <>
      <Section title="Workflow">
        <TextField id="wf-description" label="Description" value={editor.description} onChange={editor.setDescription} multiline placeholder="What this workflow is for" disabled={readOnly} />
        <UI.Field>
          <UI.FieldLabel htmlFor="wf-max-steps">Step budget</UI.FieldLabel>
          <UI.Input
            id="wf-max-steps"
            type="number"
            min={1}
            max={500}
            value={editor.spec.budget.maxSteps}
            onChange={(e) => editor.setMaxSteps(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            disabled={readOnly}
            className="w-28"
          />
          <UI.FieldDescription>Most steps a run may execute — stops runaway go-to loops.</UI.FieldDescription>
        </UI.Field>
        {editor.isNew ? (
          <UI.Field orientation="horizontal">
            <UI.Switch id="wf-default" checked={editor.setAsDefault} onCheckedChange={editor.setSetAsDefault} />
            <UI.FieldLabel htmlFor="wf-default">Make it the project’s default workflow</UI.FieldLabel>
          </UI.Field>
        ) : null}
      </Section>
      <Section title="Steps">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {Object.entries(KIND_STYLE).map(([kind, style]) =>
            counts[kind] ? (
              <div key={kind} className="flex items-center gap-2">
                <span className={UI.cn('size-2 rounded-sm', style.swatch)} aria-hidden />
                <dt className="text-muted-foreground">{style.label}</dt>
                <dd className="ml-auto tabular-nums">{counts[kind]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </Section>
      {!readOnly ? (
        <Section title="How to edit">
          <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <li>Drag a step or an agent from the left onto the canvas — or click it to add it after the selected step.</li>
            <li>Drag from a step’s right handle to another step’s left handle to connect them.</li>
            <li>Select a step to set its agent, skills and harness. Delete or Backspace removes the selection.</li>
            <li>
              Save with <kbd className="rounded border px-1 font-mono text-[10px]">Ctrl/⌘ S</kbd>. Runs already started keep the version they started with.
            </li>
          </ul>
        </Section>
      ) : null}
    </>
  )
}

export default function NodeInspector(props: InspectorProps) {
  const { editor, readOnly } = props
  const { selectedNodes, selectedEdges } = editor

  let body: ReactNode
  if (selectedNodes.length === 1) {
    body = <StepPanel key={selectedNodes[0].id} {...props} node={selectedNodes[0]} />
  } else if (selectedNodes.length > 1) {
    body = (
      <Section title={`${selectedNodes.length} steps selected`}>
        <p className="text-sm text-muted-foreground">Drag them together, or delete them all. Select a single step to edit it.</p>
        {!readOnly ? (
          <UI.Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={editor.deleteSelection}>
            <Trash2 /> Delete selected
          </UI.Button>
        ) : null}
      </Section>
    )
  } else if (selectedEdges.length > 0) {
    const label = (nodeId: string): string => editor.nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId
    body = (
      <Section title={selectedEdges.length === 1 ? 'Connection' : `${selectedEdges.length} connections`}>
        <ul className="flex flex-col gap-1.5 text-sm">
          {selectedEdges.map((e) => (
            <li key={e.id} className="flex items-center gap-2">
              <span className="truncate">{label(e.source)}</span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{label(e.target)}</span>
            </li>
          ))}
        </ul>
        {!readOnly ? (
          <UI.Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={editor.deleteSelection}>
            <Trash2 /> Remove {selectedEdges.length === 1 ? 'connection' : 'connections'}
          </UI.Button>
        ) : null}
      </Section>
    )
  } else {
    body = <WorkflowPanel editor={editor} readOnly={readOnly} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {readOnly ? (
        <p className="flex items-center gap-2 border-t p-3 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" /> Read-only — leads and owners can edit workflows.
        </p>
      ) : null}
    </div>
  )
}
