// The Settings page (account, projects, organization), imported as `* as ST`.

export type { AccessToken, ArchivedProject, MySettings, OrgPeople, ProjectDetail, SystemStatus } from '@sdlc/contracts'
export {
  archiveProject,
  createAccessToken,
  removeClient,
  restoreProject,
  revokeAccessToken,
  setOrgRole,
  updatePreferences,
  updateProject,
} from '@/service/settings.service'
export { useAccessTokens, useArchivedProjects, useMySettings, usePeople, useSystemStatus } from '@/hooks/settings/useSettings'
export { useEditorPreferences } from '@/hooks/code/useEditorPreferences'
export { useProject, useProjects } from '@/hooks/project/useProjects'
export { DEFAULT_BOARDS_WORK_ITEM_TYPES, type ProjectBoards } from '@sdlc/contracts'
export { deleteAdoToken, setAdoToken, setBoardsIdentity, updateProjectBoards } from '@/service/boards.service'
export { useAdoToken, useLinkAdoConnection } from '@/hooks/story/useMyWorkItems'
export { useBoardsIdentity, useProjectBoards } from '@/hooks/story/useBoardsSync'
export { useSession } from '@/components/providers/SessionProvider'
export { ROLE_VARIANT } from '@/utils/status'
export { default as ProfileSection } from '@/components/settings/sections/ProfileSection'
export { default as AppearanceSection } from '@/components/settings/sections/AppearanceSection'
export { default as EngineSection } from '@/components/settings/sections/EngineSection'
export { default as VsCodeSection } from '@/components/settings/sections/VsCodeSection'
export { default as GitConnectionsSection } from '@/components/settings/sections/GitConnectionsSection'
export { default as PeopleSection } from '@/components/settings/sections/PeopleSection'
export { default as SystemSection } from '@/components/settings/sections/SystemSection'
export { AppError } from '@/appError'
