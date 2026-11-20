'use client'

// Settings → VS Code: the VS Code windows connected to your account (reported by the SDLC extension every minute),
// with the agent engines installed in each, and how to connect one.

import { CircleCheck, Monitor, Trash2 } from 'lucide-react'
import { harnessLabel, knownHarness } from '@sdlc/contracts'
import { HarnessTierBadge, windowName } from '@/components/work/HarnessPicker'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'
import AccessTokensCard from './AccessTokensCard'

export default function VsCodeSection() {
  const { data: settings, error, loading, reload } = ST.useMySettings()

  async function remove(clientId: string): Promise<void> {
    try {
      await ST.removeClient(clientId)
      await reload()
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not remove the window.')
    }
  }

  if (error) return <UI.ErrorAlert title="Could not load your settings" message={error.message} />
  if (loading || !settings) return <UI.Skeleton className="h-64 rounded-xl" />
  const clients = settings.clients

  return (
    <>
      <SectionHeader title="VS Code" description="Your VS Code windows connected to the platform, and the coding harnesses installed in each." />
      {clients.length === 0 ? (
        <UI.EmptyState
          icon={<Monitor />}
          title="No VS Code window connected"
          description="Once the SDLC extension is connected to the platform, each VS Code window shows up here within a minute."
        />
      ) : (
        <UI.Card className="py-0">
          <UI.ItemGroup>
            {clients.map((c, i) => (
              <div key={c.clientId}>
                {i > 0 ? <UI.ItemSeparator /> : null}
                <UI.Item size="sm" className="rounded-none border-0 px-4">
                  <UI.ItemMedia variant="icon">
                    <Monitor />
                  </UI.ItemMedia>
                  <UI.ItemContent>
                    <UI.ItemTitle className="flex flex-wrap items-center gap-2">
                      {windowName(c)}
                      <span className="text-xs font-normal text-muted-foreground">extension {c.version}</span>
                      <UI.Badge variant={c.online ? 'success' : 'outline'}>{c.online ? 'Online' : 'Offline'}</UI.Badge>
                    </UI.ItemTitle>
                    <UI.ItemDescription>
                      {c.workspace?.remoteUrl ? (
                        <>
                          <span className="font-mono">{c.workspace.remoteUrl.replace(/^https?:\/\//, '')}</span>
                          {c.workspace.branch ? <> · <span className="font-mono">{c.workspace.branch}</span></> : null} ·{' '}
                        </>
                      ) : null}
                      last seen {UI.relativeTime(c.lastSeenAt)}
                    </UI.ItemDescription>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {c.engines.length === 0 ? <span className="text-xs text-muted-foreground">No coding harness installed</span> : null}
                      {c.engines
                        .filter((e) => e.installed !== false)
                        .map((e) => (
                          <span key={e.engine} className="inline-flex items-center gap-1">
                            <UI.Badge variant="secondary">
                              <CircleCheck />
                              {e.label ?? harnessLabel(e.engine)}
                              {e.version ? <span className="font-mono text-[10px] opacity-70">{e.version}</span> : null}
                            </UI.Badge>
                            <HarnessTierBadge tier={e.tier ?? knownHarness(e.engine)?.tier ?? 'files'} />
                          </span>
                        ))}
                    </div>
                  </UI.ItemContent>
                  <UI.ItemActions>
                    <UI.Button variant="ghost" size="sm" onClick={() => void remove(c.clientId)} title="Forget this window (it reappears while it stays connected)">
                      <Trash2 />
                    </UI.Button>
                  </UI.ItemActions>
                </UI.Item>
              </div>
            ))}
          </UI.ItemGroup>
        </UI.Card>
      )}

      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Connect VS Code</UI.CardTitle>
        </UI.CardHeader>
        <UI.CardContent>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
            <li>Install the SDLC Agent Governance extension in VS Code.</li>
            <li>
              Open the <span className="font-medium text-foreground">SDLC Governance</span> view and, under Platform Stories, choose{' '}
              <span className="font-medium text-foreground">Connect to the SDLC Platform</span>.
            </li>
            <li>
              Enter the platform API address (setting <span className="font-mono text-foreground">sdlcGovernance.platform.apiUrl</span>), then paste an
              access token created below. VS Code keeps it in its secret storage.
            </li>
            <li>The window appears above, with the agent engines it has installed. Your preferred engine is applied to it automatically.</li>
          </ol>
        </UI.CardContent>
      </UI.Card>

      <AccessTokensCard />
    </>
  )
}
