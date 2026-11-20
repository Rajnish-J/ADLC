'use client'

// Add a Git connection, or rename one / replace its token. Compact: provider, then organization and name side by
// side, then the token with its Check button inline. The token is checked with GitHub or Azure DevOps before it is
// saved, and is never shown again. An organization can hold several tokens (e.g. one per person).

import { useEffect, useState, type FormEvent } from 'react'
import { CircleCheck, ExternalLink, Info, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { CreateGitConnectionInputSchema, GIT_TOKEN_HELP, type GitConnection, type GitConnectionProvider } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import ProviderIcon from '@/components/code/ProviderIcon'
import { createConnection, testToken, updateConnection } from '@/service/connections.service'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this connection; omitted to add a new one. */
  connection?: GitConnection | null
  /** The organisation's connections, to say when this adds another token for the same organization. */
  existing?: GitConnection[]
  onSaved: (connection: GitConnection) => void
}

export default function ConnectionDialog({ open, onOpenChange, connection, existing = [], onSaved }: Props) {
  const editing = Boolean(connection)
  const [provider, setProvider] = useState<GitConnectionProvider>('azure-repos')
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [account, setAccount] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setProvider(connection?.provider ?? 'azure-repos')
    setOwner(connection?.owner ?? '')
    setName(connection?.name ?? '')
    setToken('')
    setAccount(null)
    setError(null)
  }, [open, connection])

  const help = GIT_TOKEN_HELP[provider]
  const azure = provider === 'azure-repos'
  const ownerKey = owner.trim().toLowerCase()
  const sameOwner = editing
    ? []
    : existing.filter((c) => c.provider === provider && (c.owner ?? '').toLowerCase() === ownerKey && (ownerKey !== '' || provider === 'github'))
  const canCheck = Boolean(token.trim()) && (!azure || Boolean(owner.trim()))

  function resetCheck(): void {
    setAccount(null)
    setError(null)
  }

  async function check(): Promise<void> {
    setChecking(true)
    resetCheck()
    try {
      setAccount((await testToken({ provider, owner: owner.trim() || undefined, token: token.trim() })).account)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not check the token.')
    } finally {
      setChecking(false)
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      let saved: GitConnection
      if (connection) {
        saved = await updateConnection(connection.id, { name: name.trim() || undefined, token: token.trim() || undefined })
        toast.success(token.trim() ? `Token replaced for ${saved.name}` : `Saved ${saved.name}`, {
          description: token.trim() ? 'Every repository that uses this connection picks it up on its next sync.' : undefined,
        })
      } else {
        const parsed = CreateGitConnectionInputSchema.safeParse({ provider, owner, name: name.trim() || undefined, token })
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Check the form.')
          return
        }
        saved = await createConnection(parsed.data)
        toast.success(`Connected ${saved.name}`, { description: saved.account ? `Verified as ${saved.account}.` : undefined })
      }
      onSaved(saved)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not save the connection.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${connection?.name}` : 'Add a Git connection'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Rename it, or paste a new token to replace the stored one.' : 'Projects under this organization use it to clone, sync and commit.'}
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-4">
            {!editing ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={provider}
                onValueChange={(v) => {
                  if (v === 'azure-repos' || v === 'github') {
                    setProvider(v)
                    resetCheck()
                  }
                }}
                className="w-full"
                aria-label="Provider"
              >
                <ToggleGroupItem value="azure-repos" className="flex-1 gap-2">
                  <ProviderIcon provider="azure-repos" /> Azure Repos
                </ToggleGroupItem>
                <ToggleGroupItem value="github" className="flex-1 gap-2">
                  <ProviderIcon provider="github" /> GitHub
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="conn-owner">{azure ? 'Organization' : 'Owner (optional)'}</FieldLabel>
                <Input
                  id="conn-owner"
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value)
                    resetCheck()
                  }}
                  placeholder={azure ? 'contoso' : 'acme · empty = all'}
                  className="font-mono text-sm"
                  disabled={editing}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="conn-name">Name (optional)</FieldLabel>
                <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={azure ? 'e.g. Rajnish’s token' : 'e.g. GitHub · acme'} autoComplete="off" />
              </Field>
            </div>

            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="conn-token">{editing ? 'New token (optional)' : 'Access token'}</FieldLabel>
                <a
                  href={help.url(owner.trim() || undefined)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Create a token <ExternalLink className="size-3" />
                </a>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="conn-token"
                    type="password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value)
                      resetCheck()
                    }}
                    placeholder={editing ? `Stored ${connection?.tokenHint} — blank keeps it` : 'Paste the personal access token'}
                    className="pl-9"
                    autoComplete="new-password"
                  />
                </div>
                <Button type="button" variant="outline" onClick={() => void check()} disabled={checking || saving || !canCheck}>
                  {checking ? <Spinner /> : null} Check
                </Button>
              </div>
              {account ? (
                <p className="inline-flex items-center gap-1.5 text-xs text-success" role="status">
                  <CircleCheck className="size-3.5" /> Valid — belongs to <span className="font-medium">{account}</span>
                </p>
              ) : (
                <FieldDescription className="text-xs">{help.scopes}</FieldDescription>
              )}
            </Field>

            {sameOwner.length > 0 ? (
              <p className="flex gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {owner.trim() || 'Every owner'} already has {sameOwner.length === 1 ? `“${sameOwner[0].name}”` : `${sameOwner.length} connections`}. This adds another
                  token: projects keep the connection they were imported with; others use the newest.
                </span>
              </p>
            ) : null}

            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || (!editing && !token.trim())}>
              {saving ? <Spinner /> : null}
              {editing ? 'Save' : 'Verify and save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
