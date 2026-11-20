'use client'

// Options for the Review form's pickers: the project's enabled agents and skills (only those the user may use)
// and the org's Git connections (org admins; others get an empty list).

import { useEffect, useState } from 'react'
import { listAgents } from '@/service/catalog.service'
import { listConnections } from '@/service/connections.service'
import type { OptionSets } from '@/components/chat/DraftFields'

const EMPTY: OptionSets = { agents: [], skills: [], connections: [] }

export function useDraftOptions(projectKey: string | null, enabled: boolean): OptionSets {
  const [options, setOptions] = useState<OptionSets>(EMPTY)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      const [agents, connections] = await Promise.all([
        projectKey ? listAgents(projectKey).catch(() => []) : Promise.resolve([]),
        listConnections().catch(() => []),
      ])
      if (cancelled) return
      const usable = agents.filter((a) => a.enabled && a.usable)
      setOptions({
        agents: usable.filter((a) => a.kind === 'agent').map((a) => ({ value: a.slug, label: `${a.name} (${a.slug})` })),
        skills: usable.filter((a) => a.kind === 'skill').map((a) => ({ value: a.slug, label: a.name })),
        connections: connections.map((c) => ({ value: c.id, label: `${c.name}${c.owner ? ` — ${c.owner}` : ''}` })),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [projectKey, enabled])
  return options
}
