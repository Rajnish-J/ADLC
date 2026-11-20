import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { PROJECT_ROLE_LABELS, STORY_STATUSES, STORY_STATUS_LABELS, type ProjectSummary } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { KeyTile } from '@/components/common/page-header'
import ProviderIcon from '@/components/code/ProviderIcon'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { ROLE_VARIANT, STATUS_DOT } from '@/utils/status'

export default function ProjectCard({ project }: { project: ProjectSummary }) {
  const total = STORY_STATUSES.reduce((n, s) => n + project.storyCounts[s], 0)
  return (
    <Link href={`/projects/${project.key}`} className="group block rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader>
          <div className="flex min-w-0 items-center gap-3">
            <KeyTile projectKey={project.key} />
            <div className="min-w-0">
              <CardTitle className="truncate">{project.name}</CardTitle>
              <CardDescription className="font-mono text-xs">{project.key}</CardDescription>
            </div>
          </div>
          <CardAction>
            {project.myRole ? (
              <Badge variant={ROLE_VARIANT[project.myRole]}>{PROJECT_ROLE_LABELS[project.myRole]}</Badge>
            ) : (
              <Badge variant="outline">Admin access</Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">{project.description || 'No description.'}</p>
          {project.repository ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`Repository: ${project.repository.displayName}`}>
              <ProviderIcon provider={project.repository.provider} className="size-3.5" />
              <span className="truncate font-mono">{project.repository.displayName}</span>
              {project.repository.status === 'queued' || project.repository.status === 'syncing' ? (
                <Spinner className="size-3" aria-label="Syncing" />
              ) : project.repository.status === 'failed' ? (
                <AlertTriangle className="size-3.5 text-destructive" aria-label="Last sync failed" />
              ) : null}
            </p>
          ) : null}
          <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-label="Stories by status">
            {STORY_STATUSES.map((s) =>
              project.storyCounts[s] > 0 ? (
                <Tooltip key={s}>
                  <TooltipTrigger asChild>
                    <span className={STATUS_DOT[s]} style={{ width: `${(project.storyCounts[s] / total) * 100}%` }} />
                  </TooltipTrigger>
                  <TooltipContent>
                    {STORY_STATUS_LABELS[s]}: {project.storyCounts[s]}
                  </TooltipContent>
                </Tooltip>
              ) : null,
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {STORY_STATUSES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cn('size-1.5 rounded-full', STATUS_DOT[s])} aria-hidden />
                {STORY_STATUS_LABELS[s]} <span className="font-medium text-foreground tabular-nums">{project.storyCounts[s]}</span>
              </span>
            ))}
          </div>
        </CardContent>
        <CardFooter className="justify-between text-sm text-muted-foreground">
          <span>
            {total} {total === 1 ? 'story' : 'stories'}
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            Open board <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </CardFooter>
      </Card>
    </Link>
  )
}
