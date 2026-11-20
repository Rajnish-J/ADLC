'use client'

// Commit your saved edits on this branch, straight to the remote. If someone changed one of the files on the branch
// since you started editing it, nothing is pushed: the files are listed so you can review the newer version first.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, ExternalLink, GitCommitHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { CommitInputSchema, type CommitConflict, type DraftSummary } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { commitDrafts, CommitConflictError } from '@/service/code.service'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectKey: string
  branch: string
  drafts: DraftSummary[]
  /** Pre-selected (the file being edited). */
  initialPath: string | null
  onCommitted: (paths: string[]) => void
  onReview: (path: string) => void
}

export default function CommitDialog({ open, onOpenChange, projectKey, branch, drafts, initialPath, onCommitted, onReview }: Props) {
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<CommitConflict[]>([])
  const [saving, setSaving] = useState(false)

  // Reset when the dialog opens (not on every live refresh of the drafts while it is open).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setError(null)
      setConflicts([])
      setSelected(new Set(initialPath && drafts.some((d) => d.path === initialPath) ? [initialPath] : drafts.map((d) => d.path)))
      setMessage((m) => m || (initialPath ? `Update ${initialPath.split('/').pop()}` : ''))
    }
    wasOpen.current = open
  }, [open, initialPath, drafts])

  function toggle(path: string, on: boolean): void {
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = CommitInputSchema.safeParse({ branch, message, paths: [...selected] })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    setSaving(true)
    setError(null)
    setConflicts([])
    try {
      const result = await commitDrafts(projectKey, parsed.data)
      toast.success(`Committed ${result.paths.length === 1 ? result.paths[0] : `${result.paths.length} files`} to ${result.branch}`, {
        description: `${result.sha.slice(0, 7)} · ${parsed.data.message.split('\n')[0]}`,
        action: result.webUrl ? { label: 'View', onClick: () => window.open(result.webUrl ?? '', '_blank', 'noopener,noreferrer') } : undefined,
      })
      setMessage('')
      onCommitted(result.paths)
      onOpenChange(false)
    } catch (err) {
      if (err instanceof CommitConflictError) {
        setConflicts(err.conflicts)
        setError(err.message)
      } else {
        setError(err instanceof AppError ? err.message : 'Could not commit.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Commit to {branch}</DialogTitle>
            <DialogDescription>
              Pushes a commit to <span className="font-mono">{branch}</span> on the remote, authored by you.
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="commit-message">Message</FieldLabel>
            <Textarea id="commit-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe the change" className="min-h-20" autoFocus />
          </Field>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Files ({selected.size} of {drafts.length})</p>
            <div className="flex max-h-56 flex-col overflow-y-auto rounded-lg border">
              {drafts.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">You have no saved edits on this branch.</p>
              ) : (
                drafts.map((d) => (
                  <label key={d.path} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50">
                    <Checkbox checked={selected.has(d.path)} onCheckedChange={(on) => toggle(d.path, on === true)} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={d.path}>
                      {d.path}
                    </span>
                    {d.stale ? (
                      <Badge variant="warning" className="h-4 px-1.5 text-[10px]" title="The file changed on the branch since you started editing">
                        changed upstream
                      </Badge>
                    ) : null}
                  </label>
                ))
              )}
            </div>
          </div>

          {conflicts.length > 0 ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Nothing was pushed</AlertTitle>
              <AlertDescription>
                <p>These files changed on {branch} since you started editing. Review the newer version, then keep your edit or discard it.</p>
                <ul className="mt-2 flex flex-col gap-1">
                  {conflicts.map((c) => (
                    <li key={c.path} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.path}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          onOpenChange(false)
                          onReview(c.path)
                        }}
                      >
                        <ExternalLink /> Review
                      </Button>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : error ? (
            <FieldError>{error}</FieldError>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || selected.size === 0 || !message.trim()}>
              {saving ? <Spinner /> : <GitCommitHorizontal />}
              Commit and push
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
