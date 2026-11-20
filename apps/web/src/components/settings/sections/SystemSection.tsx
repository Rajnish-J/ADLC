'use client'

// Settings → System (org admins): the server's health — API, database, git and repository syncing — plus counts.
// Shows only whether secrets are configured, never their values.

import { AlertTriangle, CircleCheck, Database, GitBranch, RefreshCw, Server, XCircle } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'

function Status({ ok, label }: { ok: boolean; label?: string }) {
  return ok ? (
    <UI.Badge variant="success">
      <CircleCheck /> {label ?? 'OK'}
    </UI.Badge>
  ) : (
    <UI.Badge variant="destructive">
      <XCircle /> {label ?? 'Problem'}
    </UI.Badge>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  )
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`

export default function SystemSection() {
  const { data: s, error, loading, reload } = ST.useSystemStatus(true)

  if (error) return <UI.ErrorAlert title="Could not load the system status" message={error.message} />
  if (loading || !s) return <UI.Skeleton className="h-64 rounded-xl" />

  return (
    <>
      <SectionHeader
        title="System"
        description="The platform server’s health. Changing these values is done in the API server’s environment."
        actions={
          <UI.Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw /> Refresh
          </UI.Button>
        }
      />
      {!s.repositories.credentialKeyConfigured ? (
        <UI.Alert>
          <AlertTriangle />
          <UI.AlertTitle>Git connection tokens use the development encryption key</UI.AlertTitle>
          <UI.AlertDescription>Set REPO_CREDENTIAL_KEY (32 random bytes, base64) on the API server before real tokens are stored. Production refuses to start without it.</UI.AlertDescription>
        </UI.Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <UI.Card>
          <UI.CardHeader>
            <UI.CardTitle className="flex items-center gap-2 text-base">
              <Server className="size-4 text-muted-foreground" /> API
            </UI.CardTitle>
            <UI.CardAction>
              <Status ok />
            </UI.CardAction>
          </UI.CardHeader>
          <UI.CardContent className="divide-y">
            <Row label="Version">{s.api.version}</Row>
            <Row label="Node.js">{s.api.nodeVersion}</Row>
            <Row label="Environment">{s.api.environment}</Row>
            <Row label="Sign-in">{s.api.authMode === 'dev' ? 'Development (seeded users)' : 'Microsoft Entra ID'}</Row>
            <Row label="Running since">{UI.relativeTime(s.api.startedAt)}</Row>
          </UI.CardContent>
        </UI.Card>
        <UI.Card>
          <UI.CardHeader>
            <UI.CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4 text-muted-foreground" /> Database
            </UI.CardTitle>
            <UI.CardAction>
              <Status ok={s.database.ok} label={s.database.ok ? 'Reachable' : 'Unreachable'} />
            </UI.CardAction>
          </UI.CardHeader>
          <UI.CardContent className="divide-y">
            <Row label="Response time">{s.database.latencyMs !== null ? `${s.database.latencyMs} ms` : '—'}</Row>
            <Row label="Migrations applied">{s.database.migrationsApplied ?? '—'}</Row>
            {s.database.error ? <Row label="Error">{s.database.error}</Row> : null}
          </UI.CardContent>
        </UI.Card>
        <UI.Card>
          <UI.CardHeader>
            <UI.CardTitle className="flex items-center gap-2 text-base">
              <GitBranch className="size-4 text-muted-foreground" /> Git and repositories
            </UI.CardTitle>
            <UI.CardAction>
              <Status ok={s.git.ok} label={s.git.ok ? 'git available' : 'git missing'} />
            </UI.CardAction>
          </UI.CardHeader>
          <UI.CardContent className="divide-y">
            <Row label="git">{s.git.version ?? s.git.error ?? '—'}</Row>
            <Row label="Token encryption key">
              {s.repositories.credentialKeyConfigured ? <Status ok label="Configured" /> : <UI.Badge variant="warning">Development key</UI.Badge>}
            </Row>
            <Row label="Largest file stored">{mb(s.repositories.maxFileBytes)}</Row>
            <Row label="Most files per branch">{s.repositories.maxFiles.toLocaleString()}</Row>
            <Row label="Syncs at the same time">{s.repositories.jobConcurrency}</Row>
            <Row label="Sync jobs now">
              {s.repositories.jobsRunning} running · {s.repositories.jobsQueued} waiting
            </Row>
          </UI.CardContent>
        </UI.Card>
        <UI.Card>
          <UI.CardHeader>
            <UI.CardTitle className="text-base">Organization</UI.CardTitle>
          </UI.CardHeader>
          <UI.CardContent className="divide-y">
            <Row label="Projects">{s.counts.projects}</Row>
            <Row label="Archived projects">{s.counts.archivedProjects}</Row>
            <Row label="Linked repositories">{s.counts.repositories}</Row>
            <Row label="Git connections">{s.counts.gitConnections}</Row>
            <Row label="People">{s.counts.people}</Row>
          </UI.CardContent>
        </UI.Card>
      </div>
    </>
  )
}
