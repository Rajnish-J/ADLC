// The Story panel's message protocol, shared by the extension host (storyPanel.ts) and the webview
// (src/webview/story). Types only — no `vscode`, nothing that pulls runtime code into the webview bundle.

import type { MemoryItem, MemoryKind, Patch, ProjectRole, Story, StoryStatus, StoryWork, UpdateStoryInput, User } from '@sdlc/contracts'

/** A story edit from the panel. The host adds the story's `version`; new criteria come with an empty `id`. */
export type StoryEdit = Omit<UpdateStoryInput, 'version'>

/** Someone the story can be assigned to. */
export interface AssignableMember {
  user: User
  role: ProjectRole
}

/** One line of the story's history, already phrased by the host. */
export interface ActivityLine {
  id: number
  actor: string | null
  /** "moved it from Ready to In progress". */
  text: string
  /** "VS Code", "Web", … when not the web app. */
  via: string | null
  createdAt: string
}

/** How this window's code-activity tracker relates to the story. */
export type PanelTracking =
  | { kind: 'tracking'; files: number }
  | { kind: 'other-branch'; branch?: string }
  | { kind: 'not-yours' }
  | { kind: 'off' }
  | { kind: 'offline'; message: string }

export interface StoryPanelData {
  story: Story
  work: StoryWork | null
  memory: MemoryItem[]
  /** Accepted project memory (or the search results for `projectQuery`). */
  projectMemory: MemoryItem[]
  projectQuery: string
  me: User | null
  tracking: PanelTracking
  branchName: string
  /** Project members the story may be assigned to; null when the user can't assign it. */
  members: AssignableMember[] | null
  /** The story's history, newest first (the first page). */
  activity: ActivityLine[]
  activityHasMore: boolean
  /** Some data could not be loaded (the rest still shows). */
  error?: string
}

export type DiffRef = { kind: 'commit'; sha: string } | { kind: 'workspace'; userId: string }

export type HostToStory =
  | { type: 'state'; data: StoryPanelData }
  | { type: 'loading'; loading: boolean }
  | { type: 'diff'; key: string; patch: Patch | null; error?: string }
  | { type: 'projectMemory'; query: string; items: MemoryItem[] }
  | { type: 'notice'; kind: 'info' | 'error'; message: string }
  | { type: 'olderActivity'; lines: ActivityLine[]; hasMore: boolean }
  /** An edit finished (ok or not) — the webview leaves its edit mode only on success. */
  | { type: 'saved'; field: string; ok: boolean }

export type StoryAction = 'pickUp' | 'startWorkflow' | 'copyBranch' | 'createBranch' | 'openInBrowser'

export type StoryToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'action'; action: StoryAction }
  | { type: 'move'; to: StoryStatus }
  | { type: 'loadDiff'; key: string; ref: DiffRef }
  | { type: 'addMemory'; kind: MemoryKind; title: string; content: string }
  | { type: 'promoteMemory'; id: string }
  | { type: 'archiveMemory'; id: string }
  | { type: 'searchProjectMemory'; query: string }
  | { type: 'openFile'; path: string; line?: number }
  /** `field` names what is being saved, echoed back in `saved`. */
  | { type: 'update'; field: string; edit: StoryEdit }
  | { type: 'assign'; userId: string | null }
  | { type: 'loadOlderActivity'; before: number }

export function diffKey(ref: DiffRef): string {
  return ref.kind === 'commit' ? `commit:${ref.sha}` : `workspace:${ref.userId}`
}
