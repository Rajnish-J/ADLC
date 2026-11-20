'use client'

// An update to the project profile drafted by the Project profiler after runs changed the code. A lead reviews what
// changed (a diff against the accepted profile), then accepts, edits and accepts, or rejects it.

import { useState } from 'react'
import Link from 'next/link'
import { Check, FileDiff, Pencil, Sparkles, X } from 'lucide-react'
import type { ProjectProfile } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { CodeDiff } from '@/components/code/Monaco'
import * as UI from '@/imports/UI.imports'
import { decideProjectProfile } from '@/service/profile.service'
import ProfileEditSheet from './ProfileEditSheet'
import ProfileView from './ProfileView'

interface Props {
  projectKey: string
  proposal: ProjectProfile
  current: ProjectProfile | null
}

export default function ProfileProposalCard({ projectKey, proposal, current }: Props) {
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const content = proposal.content
  const runChanges = content?.changelog.filter((c) => c.runId && proposal.runIds.includes(c.runId)) ?? []
  const canDecide = proposal.actions.canDecide

  async function decide(decision: 'accept' | 'reject'): Promise<void> {
    setBusy(decision)
    try {
      await decideProjectProfile(projectKey, proposal.id, { decision, comment: comment.trim() || undefined })
      UI.toast.success(decision === 'accept' ? 'Project profile updated' : 'Profile update rejected')
      setRejecting(false)
      setComment('')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save the decision.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <UI.Card className="border-warning/50">
      <UI.CardHeader>
        <UI.CardTitle className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-primary" /> Project profile update
          <UI.Badge variant="warning">Proposed · v{proposal.version}</UI.Badge>
        </UI.CardTitle>
        <UI.CardDescription>
          The Project profiler folded {proposal.runIds.length} completed run{proposal.runIds.length === 1 ? '' : 's'} into the profile
          {current ? ` (v${current.version})` : ''}. {canDecide ? 'Review what changed before agents get it.' : 'A lead accepts or rejects it.'}
        </UI.CardDescription>
        {canDecide ? (
          <UI.CardAction className="flex flex-wrap gap-2">
            <UI.Button size="sm" onClick={() => void decide('accept')} disabled={busy !== null}>
              {busy === 'accept' ? <UI.Spinner /> : <Check />} Accept
            </UI.Button>
            <ProfileEditSheet
              projectKey={projectKey}
              profile={proposal}
              acceptAfter
              trigger={
                <UI.Button size="sm" variant="outline" disabled={busy !== null}>
                  <Pencil /> Edit & accept
                </UI.Button>
              }
            />
            <UI.Button size="sm" variant="ghost" onClick={() => setRejecting(true)} disabled={busy !== null}>
              <X /> Reject
            </UI.Button>
          </UI.CardAction>
        ) : null}
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-4">
        {runChanges.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {runChanges.map((c) => (
              <li key={c.runId} className="flex items-baseline gap-2">
                <span className="text-muted-foreground">•</span>
                <span className="flex-1">{c.summary}</span>
                <Link href={`/projects/${encodeURIComponent(projectKey)}/workflow/runs/${c.runId}`} className="shrink-0 text-xs text-primary hover:underline">
                  View run
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <UI.Sheet>
            <UI.SheetTrigger asChild>
              <UI.Button size="sm" variant="outline">
                <FileDiff /> What changed
              </UI.Button>
            </UI.SheetTrigger>
            <UI.SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-6xl">
              <UI.SheetHeader className="border-b">
                <UI.SheetTitle>Profile v{current?.version ?? 0} → v{proposal.version}</UI.SheetTitle>
                <UI.SheetDescription>Left: the accepted profile agents get today. Right: the proposed update.</UI.SheetDescription>
              </UI.SheetHeader>
              <div className="min-h-0 flex-1">
                <CodeDiff path={`profile-${proposal.id}.md`} original={current?.markdown ?? ''} modified={proposal.markdown} wordWrap />
              </div>
            </UI.SheetContent>
          </UI.Sheet>
          {content ? (
            <UI.Collapsible>
              <UI.CollapsibleTrigger asChild>
                <UI.Button size="sm" variant="ghost">
                  Read the proposed profile
                </UI.Button>
              </UI.CollapsibleTrigger>
              <UI.CollapsibleContent className="pt-3">
                <ProfileView content={content} projectKey={projectKey} branch={proposal.branch} />
              </UI.CollapsibleContent>
            </UI.Collapsible>
          ) : null}
        </div>
      </UI.CardContent>

      <UI.Dialog open={rejecting} onOpenChange={setRejecting}>
        <UI.DialogContent className="sm:max-w-md">
          <UI.DialogHeader>
            <UI.DialogTitle>Reject the profile update?</UI.DialogTitle>
            <UI.DialogDescription>The accepted profile stays as it is. These runs won’t be proposed again.</UI.DialogDescription>
          </UI.DialogHeader>
          <UI.Field>
            <UI.FieldLabel htmlFor="profile-reject-comment">Comment (optional)</UI.FieldLabel>
            <UI.Textarea id="profile-reject-comment" value={comment} rows={3} maxLength={2_000} onChange={(e) => setComment(e.target.value)} placeholder="Why — e.g. the change was reverted" />
          </UI.Field>
          <UI.DialogFooter>
            <UI.Button variant="outline" onClick={() => setRejecting(false)}>
              Cancel
            </UI.Button>
            <UI.Button variant="destructive" onClick={() => void decide('reject')} disabled={busy !== null}>
              {busy === 'reject' ? <UI.Spinner /> : null} Reject update
            </UI.Button>
          </UI.DialogFooter>
        </UI.DialogContent>
      </UI.Dialog>
    </UI.Card>
  )
}
