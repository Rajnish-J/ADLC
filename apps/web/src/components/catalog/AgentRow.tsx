import Link from 'next/link'
import { AlertTriangle, Bot, ChevronRight, Cloud, GitBranch, Lock, Monitor, PenLine, Server, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { PROJECT_ROLE_LABELS, type Agent } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * Tools that change files or run commands: the platform's own, plus the names engines use in repo definitions
 * (Claude Code Edit/Write/Bash, Copilot editFiles/runInTerminal, Codex apply_patch). Compared case- and
 * punctuation-insensitively, ignoring argument patterns like `Bash(git:*)`.
 */
const WRITE_TOOLS = new Set([
  'writefile',
  'replaceinfile',
  'gitcommitandpush',
  'createpullrequest',
  'updateworkitem',
  'addworkitemcomment',
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'bash',
  'shell',
  'sh',
  'powershell',
  'exec',
  'terminal',
  'runcommands',
  'runinterminal',
  'editfiles',
  'createfile',
  'applypatch',
])

const toolKey = (tool: string): string => tool.split('(')[0].toLowerCase().replace(/[^a-z0-9]/g, '')

export const agentWrites = (agent: Pick<Agent, 'tools'>): boolean => agent.tools.some((t) => WRITE_TOOLS.has(toolKey(t)))

/** A repo definition that lists no tools leaves the choice to the engine that runs it (often: every tool). */
export const agentUnrestricted = (agent: Pick<Agent, 'tools' | 'source'>): boolean => agent.source === 'repo' && agent.tools.length === 0

/** The agent's page — skills live under /skills, everything else under /agents. */
export const agentHref = (projectKey: string, slug: string, kind: Agent['kind'] = 'agent'): string =>
  `/projects/${encodeURIComponent(projectKey)}/${kind === 'skill' ? 'skills' : 'agents'}/${encodeURIComponent(slug)}`

/** Where a repo agent's definition lives in the Code page (null for built-ins). */
export function agentSourceHref(projectKey: string, agent: Pick<Agent, 'source' | 'branch' | 'sourcePath'>): string | null {
  if (agent.source !== 'repo' || !agent.sourcePath) return null
  const q = new URLSearchParams({ path: agent.sourcePath })
  if (agent.branch) q.set('branch', agent.branch)
  return `/projects/${encodeURIComponent(projectKey)}/code?${q.toString()}`
}

/** Why the enable switch is disabled for this user, if it is. */
export function agentLockReason(agent: Agent, canConfigure: boolean): string | undefined {
  if (!agent.usable && agent.requiredRole) return `Requires ${PROJECT_ROLE_LABELS[agent.requiredRole]} or above`
  if (!canConfigure) return 'Leads and owners can change this'
  return undefined
}

/** Access rule, kind, source, where it runs and whether it can write — shared by the list and the agent page. */
export function AgentBadges({ agent }: { agent: Agent }) {
  return (
    <>
      {agent.requiredRole ? (
        <Badge
          variant={agent.usable ? 'outline' : 'warning'}
          title={`Only ${PROJECT_ROLE_LABELS[agent.requiredRole].toLowerCase()}s and above (and org admins) can use this agent`}
        >
          <ShieldCheck /> {PROJECT_ROLE_LABELS[agent.requiredRole]}+
        </Badge>
      ) : null}
      {agent.kind === 'skill' ? (
        <Badge variant="secondary">
          <Sparkles /> Skill
        </Badge>
      ) : null}
      {agent.issues.length > 0 ? (
        <Badge variant="warning" title={agent.issues.join('\n')}>
          <AlertTriangle /> Needs attention
        </Badge>
      ) : null}
      {agent.source === 'platform' ? (
        <Badge variant="outline" title="Defined on the platform (for example with the Agents or Skills assistant in Chat)">
          <Cloud /> Platform
        </Badge>
      ) : null}
      {agent.source === 'repo' ? (
        <Badge variant="outline" title={agent.branch ? `Found in the repository on ${agent.branch}` : 'Found in the repository'}>
          <GitBranch /> {agent.branch ?? 'Codebase'}
        </Badge>
      ) : null}
      {agent.executionTarget === 'local' ? (
        <Badge variant="secondary" title="Runs in the developer's VS Code, against their checkout">
          <Monitor /> VS Code
        </Badge>
      ) : (
        <Badge variant="outline" title="Runs on the platform server">
          <Server /> Server
        </Badge>
      )}
      {agentUnrestricted(agent) ? (
        <Badge variant="warning" title="The definition doesn't limit its tools — the engine running it decides, often allowing every tool.">
          <PenLine /> Tools not restricted
        </Badge>
      ) : agentWrites(agent) ? (
        <Badge variant="warning">
          <PenLine /> Can edit files
        </Badge>
      ) : (
        <Badge variant="success">
          <Lock /> Read-only
        </Badge>
      )}
    </>
  )
}

interface Props {
  agent: Agent
  projectKey: string
  canConfigure: boolean
  busy: boolean
  onToggle: (enabled: boolean) => void
  /** Workflow steps this agent is mapped to ("Story delivery › Implement"). */
  usedIn?: string[]
}

export default function AgentRow({ agent, projectKey, canConfigure, busy, onToggle, usedIn = [] }: Props) {
  return (
    <Item size="sm" className={cn('group relative rounded-none border-0 px-4 hover:bg-muted/50', !agent.enabled && 'opacity-60')}>
      <ItemMedia variant="icon">{agent.kind === 'skill' ? <Sparkles /> : <Bot />}</ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2">
          {/* The stretched link makes the whole row open the agent's page; the switch sits above it. */}
          <Link href={agentHref(projectKey, agent.slug, agent.kind)} className="after:absolute after:inset-0 hover:underline">
            {agent.name}
          </Link>
          <AgentBadges agent={agent} />
        </ItemTitle>
        <ItemDescription>{agent.description}</ItemDescription>
        {usedIn.length ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Workflow className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Used in {usedIn.join(', ')}</span>
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-1">
          {agent.tools.map((t) => (
            <Badge key={t} variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground">
              {t}
            </Badge>
          ))}
        </div>
      </ItemContent>
      <ItemActions className="relative z-10">
        {/* Restricted agents stay visible but locked: the API refuses to enable, map or run them for this user. */}
        <span title={agentLockReason(agent, canConfigure)}>
          <Switch
            checked={agent.enabled}
            disabled={!canConfigure || !agent.usable || busy}
            onCheckedChange={onToggle}
            aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
          />
        </span>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </ItemActions>
    </Item>
  )
}
