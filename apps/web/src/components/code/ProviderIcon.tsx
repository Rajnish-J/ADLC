import { FolderGit2 } from 'lucide-react'
import type { RepoProvider } from '@sdlc/contracts'
import { cn } from '@/lib/utils'

/** The host's mark, drawn in currentColor so it follows the theme. */
export default function ProviderIcon({ provider, className }: { provider: RepoProvider; className?: string }) {
  if (provider === 'github') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={cn('size-4 shrink-0 fill-current', className)}>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    )
  }
  if (provider === 'azure-repos') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={cn('size-4 shrink-0 fill-current', className)}>
        <path d="M15 3.6v8.3l-3.4 2.8-5.3-1.9v1.9L3.4 11l8.4.7V4.4L15 3.6zm-2.8.4L7.5 1v2L3 4.4 1.6 6.2v4.1l1.9.8V5.8L12.2 4z" />
      </svg>
    )
  }
  return <FolderGit2 className={cn('size-4 shrink-0', className)} aria-hidden />
}
