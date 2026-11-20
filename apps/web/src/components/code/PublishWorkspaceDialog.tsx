'use client'

// Publish a workspace: create a GitHub repository with one of the organisation's Git connections and push the
// workspace's files to it. From then on the project syncs and commits to that repository.

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { PublishWorkspaceInputSchema, suggestRepoName, type ProjectDetail } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useConnections } from '@/hooks/connections/useConnections'
import { publishWorkspace } from '@/service/code.service'

interface Props {
  project: ProjectDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}

function PublishForm({ project, onDone }: { project: ProjectDetail; onDone: () => void }) {
  const { data, error: loadError, loading } = useConnections()
  const github = (data ?? []).filter((c) => c.provider === 'github')
  const [connectionId, setConnectionId] = useState('')
  const [owner, setOwner] = useState('')
  const [name, setName] = useState(suggestRepoName(project.name))
  const [isPrivate, setIsPrivate] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const connection = github.find((c) => c.id === connectionId)

  // Default to the first GitHub connection, and its owner (or the token's own account).
  useEffect(() => {
    if (!connectionId && github[0]) setConnectionId(github[0].id)
  }, [connectionId, github])
  useEffect(() => {
    if (connection) setOwner(connection.owner ?? connection.account ?? '')
  }, [connection])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = PublishWorkspaceInputSchema.safeParse({ connectionId, owner, name, private: isPrivate })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const repo = await publishWorkspace(project.key, parsed.data)
      toast.success(`Published to ${repo.displayName}`, { description: 'Commits now go to GitHub. The first sync is running.' })
      onDone()
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not publish the workspace.')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <Spinner className="mx-auto my-8 size-6" />
  if (loadError) {
    return <p className="text-sm text-destructive">{loadError.status === 403 ? 'Only an org admin can publish with the organisation’s Git connections.' : loadError.message}</p>
  }
  if (github.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There is no GitHub connection yet.{' '}
        <Link href="/settings/git-connections" className="text-primary hover:underline">
          Add one in Settings → Git connections
        </Link>{' '}
        with a token that may create repositories.
      </p>
    )
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="publish-connection">Connection</FieldLabel>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger id="publish-connection" className="w-full">
              <SelectValue placeholder="Pick a connection" />
            </SelectTrigger>
            <SelectContent>
              {github.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.account ? <span className="text-muted-foreground"> · {c.account}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Field>
            <FieldLabel htmlFor="publish-owner">Owner</FieldLabel>
            <Input id="publish-owner" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={Boolean(connection?.owner)} className="font-mono" />
          </Field>
          <Field>
            <FieldLabel htmlFor="publish-name">Repository name</FieldLabel>
            <Input id="publish-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus />
          </Field>
        </div>
        <FieldDescription>
          Creates <span className="font-mono">{owner || '…'}/{name || '…'}</span> and pushes the workspace’s files to <span className="font-mono">main</span>.
        </FieldDescription>
        <Field orientation="horizontal">
          <Switch id="publish-private" checked={isPrivate} onCheckedChange={setIsPrivate} />
          <FieldLabel htmlFor="publish-private">Private repository</FieldLabel>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !connectionId || !name.trim()}>
          {saving ? <Spinner /> : <UploadCloud />} Publish
        </Button>
      </DialogFooter>
    </form>
  )
}

export default function PublishWorkspaceDialog({ project, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish to GitHub</DialogTitle>
          <DialogDescription>Put this workspace in a new GitHub repository. After that, commits from the Code page go to GitHub.</DialogDescription>
        </DialogHeader>
        {open ? <PublishForm project={project} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
