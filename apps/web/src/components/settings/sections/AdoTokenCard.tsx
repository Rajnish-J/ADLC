'use client'

// Settings → Profile: the Azure DevOps access My work items uses (everything assigned to you, across every project
// of your organization) — an organisation Git connection that holds your token, or your own personal access token.
// A token is checked before it is saved, stored encrypted and never shown again — only its last characters.

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import AdoConnectionSuggestions from '@/components/story/AdoConnectionSuggestions'

export default function AdoTokenCard() {
  const { data, error: loadError, loading, setData } = ST.useAdoToken()
  const [organization, setOrganization] = useState('')
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { linking, link } = ST.useLinkAdoConnection((res) => {
    setData(res)
    setEditing(false)
  })

  const current = data?.token ?? null
  const suggestions = (data?.suggestions ?? []).filter((s) => !(current?.source === 'connection' && current.connectionName === s.name))

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const saved = await ST.setAdoToken({ organization: organization.trim() || current?.organization || '', token })
      setData(saved)
      setToken('')
      setEditing(false)
      UI.toast.success('Azure DevOps token saved')
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not save the token.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await ST.deleteAdoToken()
      setData({ token: null, suggestions: data?.suggestions ?? [] })
      setEditing(false)
      UI.toast.success(current?.source === 'connection' ? 'Connection unlinked' : 'Azure DevOps token removed')
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not remove it.')
    } finally {
      setBusy(false)
    }
  }

  const showForm = !current || editing

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Azure DevOps access</UI.CardTitle>
        <UI.CardDescription>
          <Link href="/work-items" className="underline underline-offset-4">
            My work items
          </Link>{' '}
          shows everything assigned to you across every project of your organization. It needs a token that is yours: use a Git connection that holds your
          token, or add your own.
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        {loadError ? (
          <UI.ErrorAlert title="Could not load your Azure DevOps access" message={loadError.message} />
        ) : loading || !data ? (
          <UI.Skeleton className="h-24" />
        ) : (
          <div className="flex flex-col gap-5">
            {current ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">dev.azure.com/{current.organization}</span>
                  <UI.Badge variant="secondary">{current.source === 'connection' ? `Git connection · ${current.connectionName ?? ''}` : 'Your token'}</UI.Badge>
                  <UI.Badge variant="outline" className="font-mono">
                    {current.hint}
                  </UI.Badge>
                  {current.account ? <span className="text-muted-foreground">as {current.account}</span> : null}
                </div>
                {error && !showForm ? <UI.FieldError>{error}</UI.FieldError> : null}
                {showForm ? null : (
                  <div className="flex gap-2">
                    <UI.Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={busy}>
                      Use my own token
                    </UI.Button>
                    <UI.Button variant="outline" size="sm" onClick={() => void remove()} disabled={busy}>
                      {busy ? <UI.Spinner /> : null} {current.source === 'connection' ? 'Unlink' : 'Remove'}
                    </UI.Button>
                  </div>
                )}
              </div>
            ) : null}

            {suggestions.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{current ? 'Or use a Git connection' : 'Use an existing Git connection'}</p>
                <AdoConnectionSuggestions suggestions={suggestions} linking={linking} onUse={(id) => void link(id)} />
              </div>
            ) : null}

            {showForm ? (
              <form onSubmit={(e) => void submit(e)}>
                <UI.FieldGroup>
                  {suggestions.length > 0 && !current ? <p className="text-sm font-medium">Or add your own token</p> : null}
                  <UI.Field>
                    <UI.FieldLabel htmlFor="ado-org">Organization</UI.FieldLabel>
                    <UI.Input
                      id="ado-org"
                      value={organization}
                      onChange={(e) => setOrganization(e.target.value)}
                      placeholder={current?.organization ?? 'contoso or https://dev.azure.com/contoso'}
                      maxLength={200}
                      disabled={busy}
                      autoComplete="off"
                    />
                  </UI.Field>
                  <UI.Field>
                    <UI.FieldLabel htmlFor="ado-token">Personal access token</UI.FieldLabel>
                    <UI.Input
                      id="ado-token"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      maxLength={1000}
                      disabled={busy}
                      autoComplete="off"
                    />
                    <UI.FieldDescription>
                      Needs the <strong>Work Items (Read)</strong> scope. It’s checked with Azure DevOps before it’s saved, stored encrypted and never shown again.
                    </UI.FieldDescription>
                  </UI.Field>
                  {error ? <UI.FieldError>{error}</UI.FieldError> : null}
                  <div className="flex gap-2">
                    <UI.Button type="submit" disabled={busy || !token.trim() || !(organization.trim() || current?.organization)}>
                      {busy ? <UI.Spinner /> : null} Save token
                    </UI.Button>
                    {editing ? (
                      <UI.Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={busy}>
                        Cancel
                      </UI.Button>
                    ) : null}
                  </div>
                </UI.FieldGroup>
              </form>
            ) : null}
          </div>
        )}
      </UI.CardContent>
    </UI.Card>
  )
}
