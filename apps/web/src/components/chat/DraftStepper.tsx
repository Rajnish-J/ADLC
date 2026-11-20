'use client'

// The bar above the composer while a specialist builds something: Configure (project chosen) → Describe (this
// conversation) → Review, and "Review & submit", whose dot shows the draft's state.

import { Fragment } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { DRAFT_KIND_LABELS, type ChatDraft, type DraftKind } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { agentIcon } from './chatHelpers'

interface Props {
  kind: DraftKind
  icon: string
  draft: ChatDraft | null
  /** Configure is done: the project is chosen (or none is needed). */
  configured: boolean
  busy: boolean
  onReview: () => void
  className?: string
}

const STEPS = ['Configure', 'Describe', 'Review'] as const

function status(draft: ChatDraft | null): { label: string; tone: 'idle' | 'open' | 'ready' | 'done' } {
  if (!draft) return { label: 'Not started', tone: 'idle' }
  if (draft.status === 'submitted') return { label: 'Submitted', tone: 'done' }
  if (draft.ready) return { label: 'Ready to review', tone: 'ready' }
  if (draft.openQuestions.length) return { label: `${draft.openQuestions.length} open question${draft.openQuestions.length === 1 ? '' : 's'}`, tone: 'open' }
  return { label: 'Draft saved', tone: 'open' }
}

export default function DraftStepper({ kind, icon, draft, configured, busy, onReview, className }: Props) {
  const Icon = agentIcon(icon)
  const s = status(draft)
  const current = !configured ? 0 : s.tone === 'ready' || s.tone === 'done' ? 2 : 1
  const title = draft?.targetLabel ? `Edit ${DRAFT_KIND_LABELS[kind].noun}: ${draft.targetLabel}` : DRAFT_KIND_LABELS[kind].title
  const canReview = Boolean(draft) && !busy

  return (
    <div className={UI.cn('@container flex items-center gap-3 rounded-2xl border bg-card/80 px-3 py-2 shadow-sm backdrop-blur', className)}>
      <div className="hidden min-w-0 shrink items-center gap-2 @md:flex">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="truncate text-sm font-medium">{title}</span>
      </div>
      <span aria-hidden className="hidden h-5 w-px shrink-0 bg-border @md:block" />
      <ol className="flex shrink-0 items-center gap-2">
        {STEPS.map((step, i) => {
          const complete = i < current || s.tone === 'done'
          const active = i === current && s.tone !== 'done'
          return (
            <Fragment key={step}>
              {i > 0 ? <li aria-hidden className={UI.cn('h-px w-4 @lg:w-6', complete || active ? 'bg-primary/50' : 'bg-border')} /> : null}
              <li className="flex items-center gap-1.5 text-xs" aria-current={active ? 'step' : undefined}>
                <span
                  className={UI.cn(
                    'flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold',
                    complete && 'border-primary bg-primary text-primary-foreground',
                    active && 'border-primary text-primary ring-2 ring-primary/15',
                  )}
                >
                  {complete ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={UI.cn('whitespace-nowrap', active ? 'font-medium' : 'hidden text-muted-foreground @lg:inline')}>{step}</span>
              </li>
            </Fragment>
          )
        })}
      </ol>
      <span aria-hidden className="min-w-0 flex-1" />
      <UI.Button
        size="sm"
        variant={s.tone === 'ready' ? 'default' : 'outline'}
        disabled={!canReview}
        onClick={onReview}
        title={draft ? s.label : 'Available once the assistant has saved a draft'}
        aria-label={`Review & submit — ${s.label}`}
        className="h-7 shrink-0 gap-1.5 rounded-full px-3 text-xs"
      >
        <span
          aria-hidden
          className={UI.cn(
            'size-1.5 shrink-0 rounded-full',
            s.tone === 'ready' && 'bg-success',
            s.tone === 'open' && 'bg-warning',
            s.tone === 'done' && 'bg-primary',
            s.tone === 'idle' && 'bg-muted-foreground/40',
          )}
        />
        <span className="whitespace-nowrap">
          Review<span className="hidden @sm:inline"> &amp; submit</span>
        </span>
        <ArrowRight className="size-3" />
      </UI.Button>
    </div>
  )
}
