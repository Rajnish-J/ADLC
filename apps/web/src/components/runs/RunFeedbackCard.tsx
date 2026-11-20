'use client'

// People's verdict on a run, next to the gates' — thumbs up or down with an optional comment, one per person, and
// everyone's feedback listed. Feeds the runs table and the AI summary's view of how runs are going.

import { useEffect, useState } from 'react'
import { ThumbsDown, ThumbsUp, UserCheck } from 'lucide-react'
import type { ProjectRunDetail, RunFeedback, RunRating } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { useSession } from '@/components/providers/SessionProvider'
import { setRunFeedback } from '@/service/runs.service'

export default function RunFeedbackCard({ projectKey, run }: { projectKey: string; run: ProjectRunDetail }) {
  const { me } = useSession()
  const [entries, setEntries] = useState<RunFeedback[]>(run.feedbackEntries)
  useEffect(() => setEntries(run.feedbackEntries), [run.feedbackEntries])
  const mine = entries.find((f) => f.user.id === me?.user.id) ?? null
  const [rating, setRating] = useState<RunRating | null>(mine?.rating ?? null)
  const [comment, setComment] = useState(mine?.comment ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setRating(mine?.rating ?? null)
    setComment(mine?.comment ?? '')
  }, [mine?.rating, mine?.comment])

  async function save(next: RunRating | null, text = comment) {
    setBusy(true)
    try {
      setEntries(await setRunFeedback(projectKey, run.id, { rating: next, comment: next === null ? undefined : text.trim() || undefined }))
      setRating(next)
      if (next === null) setComment('')
      UI.toast.success(next === null ? 'Feedback removed' : 'Feedback saved')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save the feedback')
    } finally {
      setBusy(false)
    }
  }

  const up = entries.filter((f) => f.rating > 0).length
  const down = entries.length - up
  const dirty = rating !== null && (comment.trim() || '') !== (mine?.comment ?? '')

  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="size-4 text-muted-foreground" /> Human feedback
        </UI.CardTitle>
        <UI.CardDescription>
          {entries.length ? `${up} up · ${down} down` : 'Was this run useful? Your verdict sits next to the gates’.'}
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <UI.Button variant={rating === 1 ? 'default' : 'outline'} size="sm" aria-pressed={rating === 1} disabled={busy} onClick={() => void save(rating === 1 ? null : 1)}>
            <ThumbsUp /> Useful
          </UI.Button>
          <UI.Button variant={rating === -1 ? 'destructive' : 'outline'} size="sm" aria-pressed={rating === -1} disabled={busy} onClick={() => void save(rating === -1 ? null : -1)}>
            <ThumbsDown /> Not useful
          </UI.Button>
        </div>
        {rating !== null ? (
          <div className="flex flex-col gap-2">
            <UI.Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What was good or wrong about it? (optional)"
              rows={2}
              maxLength={2000}
              aria-label="Comment on the run"
              className="text-sm"
            />
            {dirty ? (
              <UI.Button size="sm" className="self-start" disabled={busy} onClick={() => void save(rating)}>
                Save comment
              </UI.Button>
            ) : null}
          </div>
        ) : null}
        {entries.filter((f) => f.user.id !== me?.user.id || f.comment).length ? (
          <ul className="flex flex-col divide-y border-t">
            {entries.map((f) => (
              <li key={f.user.id} className="flex items-start gap-2 py-2 text-sm">
                <UI.UserAvatar name={f.user.displayName} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{f.user.displayName}</span>
                    {f.rating > 0 ? <ThumbsUp className="size-3.5 text-success" aria-label="Useful" /> : <ThumbsDown className="size-3.5 text-destructive" aria-label="Not useful" />}
                    <span className="text-xs text-muted-foreground">{UI.relativeTime(f.updatedAt)}</span>
                  </span>
                  {f.comment ? <span className="whitespace-pre-wrap text-muted-foreground">{f.comment}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </UI.CardContent>
    </UI.Card>
  )
}
