// A project's Settings sections, in order: shared by the sidebar (the project's collapsible "Settings" group lists
// them) and the project Settings page (which renders the one in the URL, /projects/KEY/settings/<section>).

import type { ReactNode } from 'react'
import { AlertTriangle, Bot, Brain, Cpu, FolderGit2, Info, KanbanSquare } from 'lucide-react'
import type { Permission } from '@sdlc/contracts'

export interface ProjectSettingsSectionMeta {
  id: string
  title: string
  icon: ReactNode
  /** Hidden from members without this permission (the card would only say they can't). */
  requires?: Permission
}

export const PROJECT_SETTINGS_SECTIONS: ProjectSettingsSectionMeta[] = [
  { id: 'general', title: 'General', icon: <Info /> },
  { id: 'agents', title: 'Agents & skills', icon: <Bot /> },
  { id: 'harnesses', title: 'Harnesses', icon: <Cpu /> },
  { id: 'memory', title: 'Memory', icon: <Brain /> },
  { id: 'repository', title: 'Repository', icon: <FolderGit2 /> },
  { id: 'boards', title: 'Azure Boards', icon: <KanbanSquare /> },
  { id: 'danger', title: 'Danger zone', icon: <AlertTriangle />, requires: 'project.update' },
]

export const DEFAULT_PROJECT_SETTINGS_SECTION = 'general'

export const projectSettingsHref = (key: string, section = DEFAULT_PROJECT_SETTINGS_SECTION): string =>
  `/projects/${encodeURIComponent(key)}/settings/${section}`

/** The sections this member may open. */
export function visibleProjectSettingsSections(permissions: readonly string[]): ProjectSettingsSectionMeta[] {
  return PROJECT_SETTINGS_SECTIONS.filter((s) => !s.requires || permissions.includes(s.requires))
}
