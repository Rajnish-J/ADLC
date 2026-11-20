'use client'

// The assistant's questions as a card: click an option (its recommendation is preselected) or type an answer,
// then Send. Skip tells it to go ahead with its defaults. Once answered, the card collapses to the answers.

import { useState } from 'react'
import { CheckCircle2, MessageCircleQuestion } from 'lucide-react'
import type { AskUserInput, AskUserOutput } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

interface Props {
  input: AskUserInput | undefined
  output: AskUserOutput | undefined
  /** False while the assistant is still writing the questions, or once answered. */
  active: boolean
  onAnswer: (output: AskUserOutput) => void
}

export default function AskUserCard({ input, output, active, onAnswer }: Props) {
  const questions = input?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.defaultValue ?? ''])),
  )
  const answerOf = (id: string, fallback: string | null) => answers[id] ?? fallback ?? ''

  if (output) {
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-success" />
          {output.skipped ? 'Skipped — the assistant will use its defaults' : 'Your answers'}
        </span>
        {output.answers.map((a) => (
          <p key={a.id} className="text-sm">
            <span className="text-muted-foreground">{a.question}</span> <span className="font-medium">{a.answer || '—'}</span>
          </p>
        ))}
      </div>
    )
  }

  const send = (skipped: boolean) =>
    onAnswer({
      skipped,
      answers: skipped ? [] : questions.map((q) => ({ id: q.id, question: q.question, answer: answerOf(q.id, q.defaultValue).trim() })),
    })

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestion className="size-3.5" />
        {questions.length === 1 ? 'A question for you' : `${questions.length} questions for you`}
      </span>
      {questions.map((q) => {
        const value = answerOf(q.id, q.defaultValue)
        return (
          <div key={q.id} className="flex flex-col gap-2">
            <p className="text-sm font-medium">{q.question}</p>
            {q.options.length ? (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <UI.Button
                    key={o}
                    type="button"
                    size="xs"
                    variant={value === o ? 'default' : 'outline'}
                    className="h-7 rounded-full px-3"
                    disabled={!active}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                  >
                    {o}
                    {o === q.defaultValue ? <span className="text-[10px] opacity-70">· suggested</span> : null}
                  </UI.Button>
                ))}
              </div>
            ) : null}
            <UI.Input
              value={q.options.includes(value) ? '' : value}
              placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
              disabled={!active}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(false)
                }
              }}
              className="h-8 text-sm"
            />
          </div>
        )
      })}
      <div className="flex justify-end gap-2">
        <UI.Button size="sm" variant="ghost" disabled={!active} onClick={() => send(true)}>
          Skip
        </UI.Button>
        <UI.Button size="sm" disabled={!active || questions.length === 0} onClick={() => send(false)}>
          Send answers
        </UI.Button>
      </div>
    </div>
  )
}
