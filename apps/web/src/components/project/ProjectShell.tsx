'use client'

// The frame around every project page. Navigation between sections lives in the sidebar; this renders the
// project header (key, name, your role, members) and hands the loaded project to the page.

import type { ReactNode } from 'react'
import { PROJECT_ROLE_LABELS, type ProjectDetail } from '@sdlc/contracts'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorAlert } from '@/components/common/feedback'
import { KeyTile, PageHeader } from '@/components/common/page-header'
import { useCurrentProject } from '@/components/layout/current-project'
import { initials } from '@/utils/format'
import { ROLE_VARIANT } from '@/utils/status'

interface ProjectShellProps {
  /** Page title under the project (defaults to the project name). */
  title?: string
  description?: ReactNode
  actions?: (project: ProjectDetail) => ReactNode
  /** Pages with their own header (a story) skip the project header. */
  header?: boolean
  children: (project: ProjectDetail) => ReactNode
}

function Members({ project }: { project: ProjectDetail }) {
  const shown = project.members.slice(0, 5)
  return (
    <AvatarGroup>
      {shown.map((m) => (
        <Tooltip key={m.user.id}>
          <TooltipTrigger asChild>
            <Avatar className="size-8">
              <AvatarFallback className="bg-accent text-[10px] font-semibold text-accent-foreground">{initials(m.user.displayName)}</AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>
            {m.user.displayName} · {PROJECT_ROLE_LABELS[m.role]}
          </TooltipContent>
        </Tooltip>
      ))}
      {project.members.length > shown.length ? <AvatarGroupCount>+{project.members.length - shown.length}</AvatarGroupCount> : null}
    </AvatarGroup>
  )
}

export default function ProjectShell({ title, description, actions, header = true, children }: ProjectShellProps) {
  const { data: project, error, loading } = useCurrentProject()

  if (error) {
    return <ErrorAlert title={error.status === 404 ? 'Project not found' : 'Could not load the project'} message={error.message} />
  }
  if (loading || !project) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    )
  }

  return (
    <>
      {header ? (
        <PageHeader
          leading={<KeyTile projectKey={project.key} />}
          title={title ?? project.name}
          badges={
            project.myRole ? (
              <Badge variant={ROLE_VARIANT[project.myRole]}>{PROJECT_ROLE_LABELS[project.myRole]}</Badge>
            ) : (
              <Badge variant="outline">Admin access</Badge>
            )
          }
          description={description ?? project.description}
          actions={
            <>
              <Members project={project} />
              {actions ? actions(project) : null}
            </>
          }
        />
      ) : null}
      {children(project)}
    </>
  )
}
