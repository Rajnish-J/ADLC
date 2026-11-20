import type { ChangedFile } from '@sdlc/contracts'
import { ShieldAlert } from 'lucide-react'
import * as UI from '@/imports/UI.imports'

const STATUS_SHORT: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  type_changed: 'T',
  unknown: '?',
}

export default function ChangedFiles({ files, max = 50 }: { files: ChangedFile[]; max?: number }) {
  const shown = files.slice(0, max)
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {shown.map((f) => (
        <li key={f.path} className="flex items-center gap-2">
          <span className="w-3 shrink-0 text-center font-mono text-muted-foreground" title={f.status}>
            {STATUS_SHORT[f.status]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
            {f.path}
          </span>
          {f.excluded ? (
            <UI.Tooltip>
              <UI.TooltipTrigger asChild>
                <ShieldAlert className="size-3.5 text-warning-foreground dark:text-warning" aria-label="Content not shared" />
              </UI.TooltipTrigger>
              <UI.TooltipContent>Matches the secret-file patterns — its content never left the developer’s machine.</UI.TooltipContent>
            </UI.Tooltip>
          ) : null}
          {f.binary ? (
            <span className="text-muted-foreground">binary</span>
          ) : (
            <span className="shrink-0 font-mono">
              <span className="text-success">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span>
            </span>
          )}
        </li>
      ))}
      {files.length > shown.length ? <li className="text-muted-foreground">… and {files.length - shown.length} more</li> : null}
    </ul>
  )
}
