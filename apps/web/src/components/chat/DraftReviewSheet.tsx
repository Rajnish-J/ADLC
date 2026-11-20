'use client'

// Review & submit: the draft the assistant built, as an editable form (with a live canvas for workflows). Submit
// creates or updates the real thing as the user; the assistant never does that itself.

import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, Send, Trash2 } from 'lucide-react'
import { DRAFT_FORMS, DRAFT_KIND_LABELS, type ChatDraft, type WorkflowDraftDataInput } from '@sdlc/contracts'
import { validateWorkflowSpec, workflowDraftToSpec } from '@sdlc/core'
import { AppError } from '@/appError'
import * as UI from '@/imports/UI.imports'
import WorkflowCanvas from '@/components/catalog/WorkflowCanvas'
import { useDraftOptions } from '@/hooks/chat/useDraftOptions'
import { discardDraft, saveDraft, submitDraft } from '@/service/chat.service'
import { FieldsEditor } from './DraftFields'

interface Props {
  draft: ChatDraft | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The draft changed on the server (saved, submitted or discarded). */
  onChanged: (draft: ChatDraft) => void
}

type Obj = Record<string, unknown>

export default function DraftReviewSheet({ draft, open, onOpenChange, onChanged }: Props) {
  const [data, setData] = useState<Obj>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'submit' | 'discard'>(null)
  const [error, setError] = useState<string | null>(null)
  const options = useDraftOptions(draft?.projectKey ?? null, open)

  // Follow the assistant's updates until the user starts editing.
  useEffect(() => {
    if (draft && !dirty) setData(structuredClone((draft.data ?? {}) as Obj))
  }, [draft, dirty])
  useEffect(() => {
    if (!open) {
      setDirty(false)
      setError(null)
    }
  }, [open])

  const workflowPreview = useMemo(() => {
    if (draft?.kind !== 'workflow' || !Array.isArray(data.steps)) return null
    const spec = workflowDraftToSpec(data as unknown as WorkflowDraftDataInput)
    return { spec, ...validateWorkflowSpec(spec) }
  }, [draft?.kind, data])

  if (!draft) return null
  const labels = DRAFT_KIND_LABELS[draft.kind]
  const editable = draft.status === 'open'
  const submitLabel = draft.targetId ? 'Save changes' : draft.kind === 'stories' ? 'Create stories' : `Create ${labels.noun}`

  const run = async (what: 'save' | 'submit' | 'discard') => {
    setBusy(what)
    setError(null)
    try {
      let current = draft
      if (what !== 'discard' && dirty) {
        current = await saveDraft(draft.id, draft.version, data)
        setDirty(false)
        onChanged(current)
      }
      if (what === 'submit') {
        const done = await submitDraft(current.id)
        onChanged(done)
        UI.toast.success(done.result?.label ?? 'Submitted')
        onOpenChange(false)
      } else if (what === 'discard') {
        onChanged(await discardDraft(draft.id))
        onOpenChange(false)
      } else UI.toast.success('Draft saved')
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Something went wrong.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <UI.Sheet open={open} onOpenChange={onOpenChange}>
      <UI.SheetContent side="right" className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <UI.SheetHeader className="border-b">
          <UI.SheetTitle>{draft.targetLabel ? `Edit ${labels.noun}: ${draft.targetLabel}` : labels.title}</UI.SheetTitle>
          <UI.SheetDescription>
            {draft.projectKey ? `In ${draft.projectKey}. ` : ''}
            Check what the assistant drafted, change anything, then {submitLabel.toLowerCase()}.
          </UI.SheetDescription>
        </UI.SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
          {!editable ? (
            <UI.Alert>
              <UI.AlertTitle>{draft.status === 'submitted' ? 'Submitted' : 'Discarded'}</UI.AlertTitle>
              <UI.AlertDescription>{draft.result?.label ?? 'This draft is closed.'}</UI.AlertDescription>
            </UI.Alert>
          ) : null}
          {draft.openQuestions.length ? (
            <UI.Alert>
              <CircleAlert />
              <UI.AlertTitle>Still open</UI.AlertTitle>
              <UI.AlertDescription>
                <ul className="list-disc pl-4">
                  {draft.openQuestions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </UI.AlertDescription>
            </UI.Alert>
          ) : null}
          {workflowPreview ? (
            <div className="flex flex-col gap-2">
              <div className="h-64 overflow-hidden rounded-lg border [&_.workflow-canvas]:h-full!">
                <WorkflowCanvas spec={workflowPreview.spec} />
              </div>
              {[...workflowPreview.errors, ...workflowPreview.warnings].map((m) => (
                <p key={m} className={UI.cn('text-xs', workflowPreview.errors.includes(m) ? 'text-destructive' : 'text-muted-foreground')}>
                  {m}
                </p>
              ))}
            </div>
          ) : null}
          <FieldsEditor
            fields={DRAFT_FORMS[draft.kind]}
            value={data}
            options={options}
            disabled={!editable || busy !== null}
            onChange={(v) => {
              setData(v)
              setDirty(true)
            }}
          />
        </div>

        {editable ? (
          <div className="flex flex-col gap-2 border-t px-4 py-3">
            {error ? <UI.ErrorAlert title="Not submitted" message={error} /> : null}
            <div className="flex items-center gap-2">
              <UI.AlertDialog>
                <UI.AlertDialogTrigger asChild>
                  <UI.Button variant="ghost" size="sm" disabled={busy !== null} className="text-muted-foreground">
                    <Trash2 className="size-3.5" />
                    Discard
                  </UI.Button>
                </UI.AlertDialogTrigger>
                <UI.AlertDialogContent>
                  <UI.AlertDialogHeader>
                    <UI.AlertDialogTitle>Discard this draft?</UI.AlertDialogTitle>
                    <UI.AlertDialogDescription>Nothing is created. The assistant can start a new draft if you ask.</UI.AlertDialogDescription>
                  </UI.AlertDialogHeader>
                  <UI.AlertDialogFooter>
                    <UI.AlertDialogCancel>Keep it</UI.AlertDialogCancel>
                    <UI.AlertDialogAction onClick={() => void run('discard')}>Discard</UI.AlertDialogAction>
                  </UI.AlertDialogFooter>
                </UI.AlertDialogContent>
              </UI.AlertDialog>
              <span className="flex-1" />
              {dirty ? (
                <UI.Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('save')}>
                  {busy === 'save' ? <UI.Spinner className="size-3.5" /> : null}
                  Save edits
                </UI.Button>
              ) : null}
              <UI.Button size="sm" disabled={busy !== null || (workflowPreview?.errors.length ?? 0) > 0} onClick={() => void run('submit')}>
                {busy === 'submit' ? <UI.Spinner className="size-3.5" /> : <Send className="size-3.5" />}
                {submitLabel}
              </UI.Button>
            </div>
          </div>
        ) : null}
      </UI.SheetContent>
    </UI.Sheet>
  )
}
