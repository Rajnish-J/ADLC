'use client'

// Import: pick one of the organisation's Git connections (or all of them), find a repository its token can reach,
// and import it — the project takes the repository's name, and the platform clones it with that connection.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, KeyRound, Lock, RotateCw } from 'lucide-react'
import type { AccessibleRepo, GitConnection } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useConnectionRepos } from '@/hooks/connections/useConnectionRepos'
import { useConnections } from '@/hooks/connections/useConnections'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/utils/format'

const ALL = 'all'

interface Props {
  onBack: () => void
  onImport: (repo: AccessibleRepo) => Promise<void>
  canManageConnections: boolean
}

/** Substring search over the repository's name and description (predictable, unlike fuzzy matching). */
function filterRepos(_value: string, search: string, keywords?: string[]): number {
  const needle = search.trim().toLowerCase()
  if (!needle) return 1
  return (keywords ?? []).join(' ').toLowerCase().includes(needle) ? 1 : 0
}

function connectionHint(c: GitConnection): string | null {
  return c.account ?? c.owner ?? null
}

function RepoItem({ repo, selected, onSelect }: { repo: AccessibleRepo; selected: boolean; onSelect: () => void }) {
  const owner = repo.fullName.slice(0, repo.fullName.length - repo.name.length - 1)
  return (
    <CommandItem value={`${repo.connectionId}:${repo.fullName}`} keywords={[repo.fullName, repo.description ?? '']} onSelect={onSelect} className="items-start gap-2 py-2">
      <Check className={cn('mt-0.5 size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{repo.name}</span>
          {repo.private ? <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {owner}
          {repo.description ? ` · ${repo.description}` : ''}
        </span>
      </span>
      {repo.updatedAt ? <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{relativeTime(repo.updatedAt)}</span> : null}
    </CommandItem>
  )
}

export default function ImportView({ onBack, onImport, canManageConnections }: Props) {
  const connections = useConnections()
  const list = connections.data ?? []
  const [scope, setScope] = useState<string>(ALL)
  const ids = useMemo(() => (scope === ALL ? list.map((c) => c.id) : [scope]), [scope, list])
  const { byConnection, retry } = useConnectionRepos(ids)
  const [selected, setSelected] = useState<AccessibleRepo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const shown = list.filter((c) => ids.includes(c.id))
  const anyLoading = shown.some((c) => byConnection[c.id]?.loading ?? true)
  const total = shown.reduce((n, c) => n + (byConnection[c.id]?.repos.length ?? 0), 0)

  async function submit(): Promise<void> {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      await onImport(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the repository.')
      setSaving(false)
    }
  }

  const header = (
    <DialogHeader>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="-ml-2 size-8" onClick={onBack} disabled={saving} aria-label="Back">
          <ArrowLeft />
        </Button>
        <DialogTitle className="text-xl">Import</DialogTitle>
      </div>
      <DialogDescription>Pick a repository. The project takes its name, and its code, agents and skills are brought in.</DialogDescription>
    </DialogHeader>
  )

  if (connections.loading && !connections.data) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Skeleton className="h-9" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (connections.error || list.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
          <KeyRound className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{connections.error ? 'Could not load the access tokens' : 'No access tokens set up yet'}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {connections.error?.message ??
              (canManageConnections ? 'Add a personal access token once, and every repository it can reach shows up here.' : 'Ask an org admin to add a personal access token in Settings.')}
          </p>
          {canManageConnections && !connections.error ? (
            <Button asChild size="sm">
              <Link href="/settings/git-connections">Add an access token</Link>
            </Button>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {header}
      <Field>
        <FieldLabel htmlFor="import-connection">Access token</FieldLabel>
        <Select
          value={scope}
          onValueChange={(v) => {
            setScope(v)
            setSelected(null)
          }}
          disabled={saving}
        >
          <SelectTrigger id="import-connection" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All access tokens</SelectItem>
            <SelectSeparator />
            {list.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
                {connectionHint(c) ? <span className="text-muted-foreground"> · {connectionHint(c)}</span> : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Command filter={filterRepos} className="rounded-lg border">
        <CommandInput placeholder="Search repositories…" disabled={saving} />
        <CommandList className="max-h-72">
          {!anyLoading ? <CommandEmpty>{total === 0 ? 'These tokens can’t reach any repository.' : 'No repository matches.'}</CommandEmpty> : null}
          {shown.map((c) => {
            const state = byConnection[c.id]
            return (
              <CommandGroup key={c.id} heading={scope === ALL ? c.name : undefined}>
                {!state || state.loading ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                    <Spinner className="size-3" /> Listing repositories…
                  </div>
                ) : state.error ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
                    <span className="min-w-0 flex-1">{state.error.message}</span>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2" onClick={() => retry(c.id)}>
                      <RotateCw /> Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    {state.repos.map((r) => (
                      <RepoItem
                        key={`${r.connectionId}:${r.fullName}`}
                        repo={r}
                        selected={selected?.connectionId === r.connectionId && selected.fullName === r.fullName}
                        onSelect={() => setSelected(r)}
                      />
                    ))}
                    {state.truncated ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Showing the 1000 most recently pushed — search to narrow down.</p> : null}
                  </>
                )}
              </CommandGroup>
            )
          })}
        </CommandList>
      </Command>

      {error ? <FieldError>{error}</FieldError> : null}
      <DialogFooter className="items-center sm:justify-between">
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          {selected ? (
            <>
              New project <span className="font-medium text-foreground">{selected.name}</span>
            </>
          ) : (
            'Select a repository'
          )}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
            Back
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!selected || saving}>
            {saving ? <Spinner /> : null} Import
          </Button>
        </div>
      </DialogFooter>
    </div>
  )
}
