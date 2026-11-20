import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Shown before the title (e.g. a project key tile). */
  leading?: ReactNode
  /** Shown next to the title (e.g. role or status badges). */
  badges?: ReactNode
  /** Right-aligned controls (primary actions). */
  actions?: ReactNode
}

export function PageHeader({ title, description, leading, badges, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {leading}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            {badges}
          </div>
          {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** The project-key tile used in headers and the sidebar. */
export function KeyTile({ projectKey, size = 'md' }: { projectKey: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={
        size === 'sm'
          ? 'flex size-6 shrink-0 items-center justify-center rounded-md bg-primary font-mono text-[9px] font-bold text-primary-foreground'
          : 'flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground'
      }
      aria-hidden
    >
      {projectKey.slice(0, 3)}
    </span>
  )
}
