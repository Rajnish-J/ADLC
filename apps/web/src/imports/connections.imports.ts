// Git connections (org-level GitHub / Azure Repos access tokens), imported as `* as G`.

export {
  GIT_TOKEN_HELP,
  REPO_PROVIDER_LABELS,
  type GitConnection,
  type GitConnectionProvider,
} from '@sdlc/contracts'
export { AppError } from '@/appError'
export { createConnection, deleteConnection, testToken, updateConnection } from '@/service/connections.service'
export { useConnections } from '@/hooks/connections/useConnections'
export { useSession } from '@/components/providers/SessionProvider'
export { default as ConnectionDialog } from '@/components/connections/ConnectionDialog'
export { default as ProviderIcon } from '@/components/code/ProviderIcon'
