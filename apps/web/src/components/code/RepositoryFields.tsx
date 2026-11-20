'use client'

// The repository URL (and optional default branch) for a GitHub / Azure Repos repository, with a live URL check and
// "Test connection". Access is configured once in Settings → Git connections, never here.

import { useState } from 'react'
import { CircleCheck, PlugZap } from 'lucide-react'
import { parseRepoUrl, REPO_PROVIDER_LABELS, type RepoTestInput, type RepoTestResult } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import ProviderIcon from './ProviderIcon'

export interface RepositoryValues {
  url: string
  defaultBranch: string
}

export const EMPTY_REPOSITORY: RepositoryValues = { url: '', defaultBranch: '' }

/** file:// remotes are accepted only by an API running in development. */
const ALLOW_LOCAL = process.env.NODE_ENV !== 'production'

interface Props {
  id: string
  value: RepositoryValues
  onChange: (value: RepositoryValues) => void
  onTest: (input: RepoTestInput) => Promise<RepoTestResult>
  disabled?: boolean
}

export default function RepositoryFields({ id, value, onChange, onTest, disabled }: Props) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RepoTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const parsed = value.url.trim() ? parseRepoUrl(value.url, { allowLocal: ALLOW_LOCAL }) : null

  function set(patch: Partial<RepositoryValues>): void {
    setResult(null)
    setTestError(null)
    onChange({ ...value, ...patch })
  }

  async function test(): Promise<void> {
    setTesting(true)
    setResult(null)
    setTestError(null)
    try {
      setResult(await onTest({ url: value.url }))
    } catch (err) {
      setTestError(err instanceof AppError ? err.message : 'Could not reach the repository.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>Repository URL</FieldLabel>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
              {parsed?.ok ? <ProviderIcon provider={parsed.repo.provider} /> : <PlugZap className="size-4" />}
            </span>
            <Input
              id={`${id}-url`}
              value={value.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://dev.azure.com/org/project/_git/repo"
              className="pl-9 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
            />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-branch`}>Default branch</FieldLabel>
          <Input
            id={`${id}-branch`}
            value={value.defaultBranch}
            onChange={(e) => set({ defaultBranch: e.target.value })}
            placeholder={result?.defaultBranch ?? 'From the remote'}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
        </Field>
      </div>
      {parsed && !parsed.ok ? (
        <FieldError>{parsed.error}</FieldError>
      ) : parsed?.ok ? (
        <FieldDescription>
          {REPO_PROVIDER_LABELS[parsed.repo.provider]} · <span className="font-mono">{parsed.repo.displayName}</span>
        </FieldDescription>
      ) : (
        <FieldDescription>A GitHub or Azure Repos repository URL.</FieldDescription>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={disabled || testing || !parsed?.ok}>
          {testing ? <Spinner /> : <PlugZap />}
          Test connection
        </Button>
        {result ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-success">
            <CircleCheck className="size-4" />
            Reachable · {result.branchCount} {result.branchCount === 1 ? 'branch' : 'branches'}
            {result.defaultBranch ? (
              <>
                {' '}
                · default <span className="font-mono">{result.defaultBranch}</span>
              </>
            ) : null}
          </span>
        ) : null}
        {testError ? <span className="text-sm text-destructive">{testError}</span> : null}
      </div>
    </div>
  )
}

/** The repository part of a create / link request, or undefined when no URL was entered. */
export function repositoryInput(v: RepositoryValues): { url: string; defaultBranch?: string } | undefined {
  if (!v.url.trim()) return undefined
  return { url: v.url.trim(), defaultBranch: v.defaultBranch.trim() || undefined }
}
