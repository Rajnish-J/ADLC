// The Settings sections, in order: shared by the sidebar (the collapsible "Settings" group lists them) and the
// Settings page (which renders the one in the URL, /settings/<section>).

import type { ReactNode } from 'react'
import { Activity, Archive, Bot, KeyRound, Monitor, Palette, User, Users } from 'lucide-react'

export type SettingsGroup = 'Account' | 'Projects' | 'Organization'

export interface SettingsSectionMeta {
  id: string
  title: string
  group: SettingsGroup
  icon: ReactNode
  /** Org admins only. */
  adminOnly?: boolean
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: 'profile', title: 'Profile', group: 'Account', icon: <User /> },
  { id: 'appearance', title: 'Appearance', group: 'Account', icon: <Palette /> },
  { id: 'engine', title: 'Agent engine', group: 'Account', icon: <Bot /> },
  { id: 'vscode', title: 'VS Code', group: 'Account', icon: <Monitor /> },
  { id: 'git-connections', title: 'Git connections', group: 'Organization', icon: <KeyRound />, adminOnly: true },
  { id: 'people', title: 'People', group: 'Organization', icon: <Users />, adminOnly: true },
  { id: 'system', title: 'System', group: 'Organization', icon: <Activity />, adminOnly: true },
  // A project's own settings live on the project (/projects/KEY/settings); archived projects have no page to open.
  { id: 'archived-projects', title: 'Archived projects', group: 'Organization', icon: <Archive />, adminOnly: true },
]

/** The first section: what /settings opens. */
export const DEFAULT_SETTINGS_SECTION = 'profile'

export const settingsHref = (section: string, query?: Record<string, string>): string =>
  `/settings/${section}${query ? `?${new URLSearchParams(query).toString()}` : ''}`

/** The sections this user may open. */
export function visibleSettingsSections(isAdmin: boolean): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter((s) => !s.adminOnly || isAdmin)
}
