'use client'

// Settings → VS Code: personal access tokens. When the web app signs people in with Microsoft, the VS Code extension
// signs in with one of these instead: create it here, paste it into "SDLC: Connect to the SDLC Platform". The token is
// shown once — the API keeps only a hash — and can be revoked at any time.

import { useState, type FormEvent } from 'react'
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const

function expiryLabel(token: ST.AccessToken): { text: string; expired: boolean } {
  if (!token.expiresAt) return { text: 'Never expires', expired: false }
  const expired = new Date(token.expiresAt).getTime() <= Date.now()
  return { text: `${expired ? 'Expired' : 'Expires'} ${UI.dateTime(token.expiresAt)}`, expired }
}

export default function AccessTokensCard() {
  const { data: tokens, error: loadError, loading, reload } = ST.useAccessTokens()
  const [name, setName] = useState('VS Code')
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]['value']>('90')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<ST.AccessToken | null>(null)

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await ST.createAccessToken({ name: name.trim(), expiresInDays: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365) })
      setCreated(res.token)
      setCopied(false)
      await reload()
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not create the token.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(token: ST.AccessToken): Promise<void> {
    try {
      await ST.revokeAccessToken(token.id)
      UI.toast.success(`Revoked “${token.name}”`)
      await reload()
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not revoke the token.')
    } finally {
      setRevoking(null)
    }
  }

  async function copy(): Promise<void> {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created)
      setCopied(true)
    } catch {
      UI.toast.error('Could not copy — select the token and copy it by hand.')
    }
  }

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Access tokens</UI.CardTitle>
        <UI.CardDescription>
          VS Code signs in to the platform with a personal access token. It acts as you, with your roles, until it expires or you revoke it.
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-5">
        <form onSubmit={(e) => void create(e)}>
          <UI.FieldGroup>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
              <UI.Field>
                <UI.FieldLabel htmlFor="pat-name">Name</UI.FieldLabel>
                <UI.Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={busy} placeholder="Work laptop" />
              </UI.Field>
              <UI.Field>
                <UI.FieldLabel htmlFor="pat-expiry">Expires</UI.FieldLabel>
                <UI.Select value={expiry} onValueChange={(v) => setExpiry(v as typeof expiry)} disabled={busy}>
                  <UI.SelectTrigger id="pat-expiry" className="w-full">
                    <UI.SelectValue />
                  </UI.SelectTrigger>
                  <UI.SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <UI.SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </UI.SelectItem>
                    ))}
                  </UI.SelectContent>
                </UI.Select>
              </UI.Field>
              <UI.Button type="submit" disabled={busy || !name.trim()}>
                {busy ? <UI.Spinner /> : <KeyRound />} Create token
              </UI.Button>
            </div>
            {error ? <UI.FieldError>{error}</UI.FieldError> : null}
          </UI.FieldGroup>
        </form>

        {loadError ? (
          <UI.ErrorAlert title="Could not load your access tokens" message={loadError.message} />
        ) : loading || !tokens ? (
          <UI.Skeleton className="h-16" />
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No access tokens yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <UI.ItemGroup>
              {tokens.map((t, i) => {
                const exp = expiryLabel(t)
                return (
                  <div key={t.id}>
                    {i > 0 ? <UI.ItemSeparator /> : null}
                    <UI.Item size="sm" className="rounded-none border-0 px-4">
                      <UI.ItemMedia variant="icon">
                        <KeyRound />
                      </UI.ItemMedia>
                      <UI.ItemContent>
                        <UI.ItemTitle className="flex flex-wrap items-center gap-2">
                          {t.name}
                          <UI.Badge variant="outline" className="font-mono">
                            {t.prefix}…
                          </UI.Badge>
                          {exp.expired ? <UI.Badge variant="destructive">Expired</UI.Badge> : null}
                        </UI.ItemTitle>
                        <UI.ItemDescription>
                          Created {UI.relativeTime(t.createdAt)} · {t.lastUsedAt ? `last used ${UI.relativeTime(t.lastUsedAt)}` : 'never used'} · {exp.text}
                        </UI.ItemDescription>
                      </UI.ItemContent>
                      <UI.ItemActions>
                        <UI.Button variant="ghost" size="sm" onClick={() => setRevoking(t)} title="Revoke this token">
                          <Trash2 />
                        </UI.Button>
                      </UI.ItemActions>
                    </UI.Item>
                  </div>
                )
              })}
            </UI.ItemGroup>
          </div>
        )}
      </UI.CardContent>

      <UI.Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <UI.DialogContent>
          <UI.DialogHeader>
            <UI.DialogTitle>Copy your access token</UI.DialogTitle>
            <UI.DialogDescription>This is the only time it is shown. Store it somewhere safe, or paste it into VS Code now.</UI.DialogDescription>
          </UI.DialogHeader>
          <div className="flex items-center gap-2">
            <UI.Input readOnly value={created ?? ''} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <UI.Button variant="outline" size="icon" onClick={() => void copy()} title="Copy">
              {copied ? <Check /> : <Copy />}
            </UI.Button>
          </div>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>
              In VS Code, run <span className="font-medium text-foreground">SDLC Platform: Connect to the SDLC Platform…</span>.
            </li>
            <li>Enter the API address, then paste this token when asked.</li>
          </ol>
          <UI.DialogFooter>
            <UI.Button onClick={() => setCreated(null)}>Done</UI.Button>
          </UI.DialogFooter>
        </UI.DialogContent>
      </UI.Dialog>

      <UI.AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <UI.AlertDialogContent>
          <UI.AlertDialogHeader>
            <UI.AlertDialogTitle>Revoke “{revoking?.name}”?</UI.AlertDialogTitle>
            <UI.AlertDialogDescription>Anything using this token, such as a VS Code window, is signed out on its next request. This can’t be undone.</UI.AlertDialogDescription>
          </UI.AlertDialogHeader>
          <UI.AlertDialogFooter>
            <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
            <UI.AlertDialogAction variant="destructive" onClick={() => revoking && void revoke(revoking)}>
              Revoke
            </UI.AlertDialogAction>
          </UI.AlertDialogFooter>
        </UI.AlertDialogContent>
      </UI.AlertDialog>
    </UI.Card>
  )
}
