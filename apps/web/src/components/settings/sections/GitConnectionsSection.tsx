'use client'

// Settings → Git connections: the organisation's GitHub / Azure Repos access tokens, set up once by an org admin. Creating a
// project then only needs the repository URL — the platform picks the matching connection whenever it clones,
// syncs or commits, and replacing a token here updates every project at once.

import { Fragment, useState } from 'react'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as G from '@/imports/connections.imports'
import SectionHeader from '../SectionHeader'

function scopeLabel(c: G.GitConnection): string {
  if (c.provider === 'azure-repos') return `dev.azure.com/${c.owner}`
  return c.owner ? `github.com/${c.owner}` : 'Every GitHub owner'
}

function Row({ connection, onEdit, onDelete }: { connection: G.GitConnection; onEdit: () => void; onDelete: () => Promise<void> }) {
  const c = connection
  return (
    <UI.Item size="sm" className="rounded-none border-0 px-4">
      <UI.ItemMedia variant="icon">
        <G.ProviderIcon provider={c.provider} />
      </UI.ItemMedia>
      <UI.ItemContent>
        <UI.ItemTitle className="flex flex-wrap items-center gap-2">
          {c.name}
          <UI.Badge variant="outline" className="font-mono text-[11px] font-normal">
            {scopeLabel(c)}
          </UI.Badge>
          <UI.Badge variant="secondary">
            <KeyRound /> {c.tokenHint}
          </UI.Badge>
        </UI.ItemTitle>
        <UI.ItemDescription>
          {c.account ? `Token of ${c.account}` : 'Token verified'} · checked {UI.relativeTime(c.verifiedAt)} · used by {c.repositories}{' '}
          {c.repositories === 1 ? 'repository' : 'repositories'}
          {c.lastUsedAt ? ` · last used ${UI.relativeTime(c.lastUsedAt)}` : ''}
          {c.createdBy ? ` · added by ${c.createdBy}` : ''}
        </UI.ItemDescription>
      </UI.ItemContent>
      <UI.ItemActions>
        <UI.Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil /> Replace token
        </UI.Button>
        <UI.AlertDialog>
          <UI.AlertDialogTrigger asChild>
            <UI.Button variant="ghost" size="sm" aria-label={`Remove ${c.name}`}>
              <Trash2 />
            </UI.Button>
          </UI.AlertDialogTrigger>
          <UI.AlertDialogContent>
            <UI.AlertDialogHeader>
              <UI.AlertDialogTitle>Remove {c.name}?</UI.AlertDialogTitle>
              <UI.AlertDialogDescription>
                {c.repositories > 0
                  ? `${c.repositories} ${c.repositories === 1 ? 'repository uses' : 'repositories use'} this connection. Private ones will fail to sync and commit until another connection covers them.`
                  : 'No linked repository uses it right now.'}{' '}
                The token is deleted from the platform; it stays valid at {c.provider === 'github' ? 'GitHub' : 'Azure DevOps'} until you revoke it there.
              </UI.AlertDialogDescription>
            </UI.AlertDialogHeader>
            <UI.AlertDialogFooter>
              <UI.AlertDialogCancel>Cancel</UI.AlertDialogCancel>
              <UI.AlertDialogAction variant="destructive" onClick={() => void onDelete()}>
                Remove
              </UI.AlertDialogAction>
            </UI.AlertDialogFooter>
          </UI.AlertDialogContent>
        </UI.AlertDialog>
      </UI.ItemActions>
    </UI.Item>
  )
}

/** Settings → Git connections (org admins; the Settings page hides it from everyone else). */
function Connections() {
  const { data, error, loading, reload } = G.useConnections()
  const [dialog, setDialog] = useState<{ open: boolean; connection: G.GitConnection | null }>({ open: false, connection: null })

  async function remove(c: G.GitConnection): Promise<void> {
    try {
      await G.deleteConnection(c.id)
      UI.toast.success(`Removed ${c.name}`)
      await reload()
    } catch (err) {
      UI.toast.error(err instanceof G.AppError ? err.message : 'Could not remove the connection.')
    }
  }

  const add = (
    <UI.Button onClick={() => setDialog({ open: true, connection: null })}>
      <Plus /> Add connection
    </UI.Button>
  )

  let body: React.ReactNode
  if (error) body = <UI.ErrorAlert title="Could not load the connections" message={error.message} />
  else if (loading || !data) body = <UI.Skeleton className="h-48 rounded-xl" />
  else if (data.length === 0) {
    body = (
      <UI.EmptyState
        icon={<KeyRound />}
        title="No Git connections yet"
        description="Add a token for your Azure DevOps organization or GitHub account once. Projects with public repositories work without one."
      >
        {add}
      </UI.EmptyState>
    )
  } else {
    body = (
      <UI.Card className="py-0">
        <UI.ItemGroup>
          {data.map((c, i) => (
            <Fragment key={c.id}>
              {i > 0 ? <UI.ItemSeparator /> : null}
              <Row connection={c} onEdit={() => setDialog({ open: true, connection: c })} onDelete={() => remove(c)} />
            </Fragment>
          ))}
        </UI.ItemGroup>
      </UI.Card>
    )
  }

  return (
    <>
      <SectionHeader
        title="PAT Token"
        description="Access tokens for GitHub and Azure Repos, set up once for the whole organization. Projects only need their repository URL — the platform uses the matching connection to clone, sync and commit."
        actions={data && data.length > 0 ? add : null}
      />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { title: 'Several tokens per organization', text: 'Add one per person or purpose. GitHub can also have one token for every owner.' },
          { title: 'Picked automatically', text: 'A repository uses the connection it was imported with, else the newest for its organization or owner. Public repositories need none.' },
          { title: 'Never shown again', text: 'Tokens are checked with the provider, stored encrypted, and only handed to git. Replace one here when it expires.' },
        ].map((tip) => (
          <UI.Card key={tip.title} className="gap-1 py-4">
            <UI.CardHeader className="px-4">
              <UI.CardTitle className="text-sm">{tip.title}</UI.CardTitle>
            </UI.CardHeader>
            <UI.CardContent className="px-4 text-sm text-muted-foreground">{tip.text}</UI.CardContent>
          </UI.Card>
        ))}
      </div>
      {body}
      <G.ConnectionDialog
        open={dialog.open}
        connection={dialog.connection}
        existing={data ?? []}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={() => void reload()}
      />
    </>
  )
}

export default Connections
