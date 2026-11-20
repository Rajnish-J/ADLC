'use client'

// Settings → Profile: the identity your Azure DevOps work items are matched against when Azure Boards syncs them
// into stories — your email, unless you set the email / UPN Azure DevOps shows for you.

import { useEffect, useState, type FormEvent } from 'react'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

export default function BoardsIdentityCard() {
  const { data, error: loadError, loading, setData } = ST.useBoardsIdentity()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValue(data?.override ?? '')
  }, [data?.override])

  async function save(identity: string | null): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const next = await ST.setBoardsIdentity(identity)
      setData(next)
      setValue(next.override ?? '')
      UI.toast.success(next.override ? 'Azure DevOps identity saved' : 'Azure DevOps identity cleared — your email is used')
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not save your Azure DevOps identity.')
    } finally {
      setSaving(false)
    }
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    void save(value.trim() || null)
  }

  const dirty = value.trim() !== (data?.override ?? '')

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Azure DevOps identity</UI.CardTitle>
        <UI.CardDescription>
          Work items assigned to you in Azure Boards sync into linked projects as your stories. They’re matched by your email unless Azure DevOps knows you by
          another one.
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        {loadError ? (
          <UI.ErrorAlert title="Could not load your Azure DevOps identity" message={loadError.message} />
        ) : loading || !data ? (
          <UI.Skeleton className="h-24" />
        ) : (
          <form onSubmit={submit}>
            <UI.FieldGroup>
              <p className="text-sm">
                <span className="text-muted-foreground">Matching work items assigned to </span>
                <span className="font-medium">{data.identity}</span>
                {data.override ? null : <span className="text-muted-foreground"> (your email)</span>}
              </p>
              <UI.Field>
                <UI.FieldLabel htmlFor="boards-identity">Override</UI.FieldLabel>
                <UI.Input
                  id="boards-identity"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="name@contoso.com"
                  maxLength={254}
                  disabled={saving}
                />
                <UI.FieldDescription>The email or UPN shown for you in Azure DevOps. Leave empty to use your email.</UI.FieldDescription>
              </UI.Field>
              {error ? <UI.FieldError>{error}</UI.FieldError> : null}
              <div className="flex gap-2">
                <UI.Button type="submit" disabled={!dirty || saving}>
                  {saving ? <UI.Spinner /> : null} Save
                </UI.Button>
                {data.override ? (
                  <UI.Button type="button" variant="outline" onClick={() => void save(null)} disabled={saving}>
                    Clear
                  </UI.Button>
                ) : null}
              </div>
            </UI.FieldGroup>
          </form>
        )}
      </UI.CardContent>
    </UI.Card>
  )
}
