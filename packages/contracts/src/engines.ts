// Agent harnesses ("engines" in code): the coding agent already installed in the developer's VS Code that runs a
// story session — GitHub Copilot, Claude Code, Codex, or any other harness the extension detects. The set is open:
// the extension reports what is installed in each VS Code window, and the UIs only ever offer those. Each user
// picks one; each project sets a default and may restrict which harnesses its runs use.

import { z } from 'zod'

/**
 * How much of a workflow run the platform can see and steer in a harness:
 * - `full`  — SDLC checkpoint tools (MCP) plus hooks: every step, agent, skill, tool call and file edit is reported.
 * - `tools` — SDLC checkpoint tools only: steps, plans, approvals and summaries, but no per-tool activity.
 * - `files` — checkpoints through files the agent writes under `.sdlc/sessions/`; the prompt is copied or prefilled.
 */
export const HARNESS_TIERS = ['full', 'tools', 'files'] as const
export type HarnessTier = (typeof HARNESS_TIERS)[number]

export const HARNESS_TIER_LABELS: Record<HarnessTier, string> = {
  full: 'Full detail',
  tools: 'Checkpoints',
  files: 'Basic',
}

/** A harness id: lowercase letters, digits and dashes (`claude-code`, `roo-code`, `my-harness`). */
export const HarnessIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'A harness id is lowercase letters, digits and dashes.')
export type HarnessId = string

export interface KnownHarness {
  id: HarnessId
  label: string
  /** VS Code extension ids that provide it (the first one is the canonical id). */
  extensionIds: string[]
  /** The best tier the platform can reach with it today. */
  tier: HarnessTier
}

/** Harnesses the extension knows how to detect and drive. Others can be added locally as `files`-tier harnesses. */
export const KNOWN_HARNESSES: readonly KnownHarness[] = [
  { id: 'copilot', label: 'GitHub Copilot', extensionIds: ['GitHub.copilot-chat'], tier: 'full' },
  { id: 'claude-code', label: 'Claude Code', extensionIds: ['anthropic.claude-code'], tier: 'full' },
  { id: 'codex', label: 'Codex', extensionIds: ['openai.chatgpt'], tier: 'tools' },
  { id: 'roo-code', label: 'Roo Code', extensionIds: ['RooVeterinaryInc.roo-cline'], tier: 'tools' },
  { id: 'kilo-code', label: 'Kilo Code', extensionIds: ['kilocode.kilo-code'], tier: 'tools' },
  { id: 'continue', label: 'Continue', extensionIds: ['Continue.continue'], tier: 'files' },
  { id: 'gemini', label: 'Gemini Code Assist', extensionIds: ['Google.geminicodeassist'], tier: 'files' },
  { id: 'amazon-q', label: 'Amazon Q', extensionIds: ['AmazonWebServices.amazon-q-vscode'], tier: 'files' },
  { id: 'cline', label: 'Cline', extensionIds: ['saoudrizwan.claude-dev'], tier: 'files' },
]

const KNOWN_BY_ID = new Map(KNOWN_HARNESSES.map((h) => [h.id, h]))

/** The known harness with this id, if any. */
export function knownHarness(id: string): KnownHarness | undefined {
  return KNOWN_BY_ID.get(id)
}

/** A display name for any harness id (known ones by label; others title-cased from the id). */
export function harnessLabel(id: string): string {
  return KNOWN_BY_ID.get(id)?.label ?? id.replace(/(^|-)([a-z0-9])/g, (_, dash: string, c: string) => (dash ? ' ' : '') + c.toUpperCase())
}

// ─── Compatibility names (the first three harnesses, as the settings UI was first built) ─────────────────────────

/** The three original harnesses. Kept for callers that list them; the full set is KNOWN_HARNESSES. */
export const AGENT_ENGINES = ['copilot', 'claude-code', 'codex'] as const
export const AgentEngineSchema = HarnessIdSchema
export type AgentEngine = HarnessId

export const AGENT_ENGINE_LABELS: Record<string, string> = Object.fromEntries(KNOWN_HARNESSES.map((h) => [h.id, h.label]))

/** VS Code extension id that provides each known harness. */
export const AGENT_ENGINE_EXTENSION_IDS: Record<string, string> = Object.fromEntries(
  KNOWN_HARNESSES.map((h) => [h.id, h.extensionIds[0]]),
)

// ─── Preferences and project settings ──────────────────────────────────────────────────────────────────────────

export const UserPreferencesSchema = z.object({
  /** Null when the user never chose — the project default applies. */
  agentEngine: HarnessIdSchema.nullable(),
  engineModel: z.string().max(120).nullable(),
  updatedAt: z.string().nullable(),
})
export type UserPreferences = z.infer<typeof UserPreferencesSchema>

export const UpdatePreferencesInputSchema = z.object({
  agentEngine: HarnessIdSchema.nullable().optional(),
  engineModel: z.string().trim().max(120).nullable().optional(),
})
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesInputSchema>

/** Quick-fix (story-less) run memory: proposed to project memory for a lead to accept, or accepted straight away. */
export const QUICK_FIX_MEMORY_POLICIES = ['propose', 'accept'] as const
export type QuickFixMemoryPolicy = (typeof QUICK_FIX_MEMORY_POLICIES)[number]

/** Characters of memory a run is given (the Markdown written to the session's memory.md). */
export const MEMORY_CONTEXT_BUDGET = { min: 2_000, max: 40_000, default: 12_000 } as const

/** What the platform remembers on its own for a project, and what runs are given. */
export const ProjectMemorySettingsSchema = z.object({
  /** Write a summary of every completed run (prompt, what the agent reported, files changed). */
  captureRunSummaries: z.boolean(),
  /** Record a learning when a quality gate fails or a plan is rejected with a comment. */
  captureLearnings: z.boolean(),
  /** Propose a project summary when a story is marked done. */
  proposeOnStoryDone: z.boolean(),
  quickFixMemory: z.enum(QUICK_FIX_MEMORY_POLICIES),
  /** Give runs the project's (and story's) memory at all. */
  provideToRuns: z.boolean(),
  contextBudget: z.number().int().min(MEMORY_CONTEXT_BUDGET.min).max(MEMORY_CONTEXT_BUDGET.max),
})
export type ProjectMemorySettings = z.infer<typeof ProjectMemorySettingsSchema>

export const DEFAULT_MEMORY_SETTINGS: ProjectMemorySettings = {
  captureRunSummaries: true,
  captureLearnings: true,
  proposeOnStoryDone: true,
  quickFixMemory: 'propose',
  provideToRuns: true,
  contextBudget: MEMORY_CONTEXT_BUDGET.default,
}

/** Debounce window (seconds) before runs that ended close together are folded into one profile proposal. */
export const PROFILE_DEBOUNCE_SECONDS = { min: 30, max: 600, default: 90 } as const

/** How the project uses the AI model with its memory: the Project profiler, semantic search, curated run context. */
export const ProjectAiSettingsSchema = z.object({
  /** Deployment the Project profiler writes with (an id from the chat models); null = the default model. */
  profileModel: z.string().trim().min(1).max(120).nullable(),
  /** The profiler reads accepted project memory (conventions, decisions, learnings, pinned items). */
  profileIncludesMemory: z.boolean(),
  /** Runs that change code propose an updated profile. */
  autoProposeProfile: z.boolean(),
  profileDebounceSeconds: z.number().int().min(PROFILE_DEBOUNCE_SECONDS.min).max(PROFILE_DEBOUNCE_SECONDS.max),
  /** Find related memory by meaning (embeddings) as well as by keywords. Needs an embedding deployment. */
  semanticSearch: z.boolean(),
  /** The model writes each run a focused memory brief from the candidates (adds a model call per run). */
  curateRunContext: z.boolean(),
  /** Deployment that curates run context; null = the default model. */
  curatorModel: z.string().trim().min(1).max(120).nullable(),
})
export type ProjectAiSettings = z.infer<typeof ProjectAiSettingsSchema>

export const DEFAULT_AI_SETTINGS: ProjectAiSettings = {
  profileModel: null,
  profileIncludesMemory: true,
  autoProposeProfile: true,
  profileDebounceSeconds: PROFILE_DEBOUNCE_SECONDS.default,
  semanticSearch: true,
  curateRunContext: false,
  curatorModel: null,
}

export const ProjectSettingsSchema = z.object({
  defaultEngine: HarnessIdSchema,
  /** Harnesses this project's runs may use. Empty = any harness the developer has installed. */
  allowedEngines: z.array(HarnessIdSchema).max(40),
  memory: ProjectMemorySettingsSchema,
  ai: ProjectAiSettingsSchema,
})
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  defaultEngine: 'copilot',
  allowedEngines: [],
  memory: DEFAULT_MEMORY_SETTINGS,
  ai: DEFAULT_AI_SETTINGS,
}

/** A settings change: only what is sent changes (the harness card and the memory card save independently). */
export const ProjectSettingsPatchSchema = z.object({
  defaultEngine: HarnessIdSchema.optional(),
  allowedEngines: z.array(HarnessIdSchema).max(40).optional(),
  memory: ProjectMemorySettingsSchema.partial().optional(),
  ai: ProjectAiSettingsSchema.partial().optional(),
})
export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>

export const UpdateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  settings: ProjectSettingsPatchSchema.optional(),
})
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>

/** Reads a stored settings object field by field, filling every missing or invalid field with its default. */
function readFields<T extends Record<string, unknown>>(raw: unknown, shape: z.ZodRawShape, defaults: T): T {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = { ...defaults }
  for (const [key, schema] of Object.entries(shape)) {
    const parsed = (schema as z.ZodTypeAny).safeParse(source[key])
    if (parsed.success) out[key] = parsed.data
  }
  return out as T
}

function readMemorySettings(raw: unknown): ProjectMemorySettings {
  return readFields(raw, ProjectMemorySettingsSchema.shape, DEFAULT_MEMORY_SETTINGS)
}

function readAiSettings(raw: unknown): ProjectAiSettings {
  return readFields(raw, ProjectAiSettingsSchema.shape, DEFAULT_AI_SETTINGS)
}

/** Reads stored (possibly partial or stale) settings JSON into a valid ProjectSettings. */
export function readProjectSettings(raw: unknown): ProjectSettings {
  const parsed = ProjectSettingsSchema.omit({ memory: true, ai: true }).partial().safeParse(raw ?? {})
  const s = parsed.success ? parsed.data : {}
  const allowed = [...new Set(s.allowedEngines ?? [])]
  const def = s.defaultEngine && isHarnessAllowed(s.defaultEngine, allowed) ? s.defaultEngine : (allowed[0] ?? DEFAULT_PROJECT_SETTINGS.defaultEngine)
  const memory = readMemorySettings(raw && typeof raw === 'object' ? (raw as { memory?: unknown }).memory : undefined)
  const ai = readAiSettings(raw && typeof raw === 'object' ? (raw as { ai?: unknown }).ai : undefined)
  return { defaultEngine: def, allowedEngines: allowed, memory, ai }
}

/** Applies a settings change on top of the stored settings (memory merges field by field). */
export function mergeProjectSettings(current: ProjectSettings, patch: ProjectSettingsPatch): ProjectSettings {
  return readProjectSettings({
    defaultEngine: patch.defaultEngine ?? current.defaultEngine,
    allowedEngines: patch.allowedEngines ?? current.allowedEngines,
    memory: { ...current.memory, ...(patch.memory ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
  })
}

/** Whether a project's allow-list admits this harness (an empty list admits every harness). */
export function isHarnessAllowed(id: string, allowed: readonly string[]): boolean {
  return allowed.length === 0 || allowed.includes(id)
}

/** The harness a session uses by default: the user's pick if the project allows it, else the project default. */
export function effectiveEngine(user: string | null | undefined, project: ProjectSettings | null | undefined): HarnessId {
  const settings = project ?? DEFAULT_PROJECT_SETTINGS
  if (user && isHarnessAllowed(user, settings.allowedEngines)) return user
  return settings.defaultEngine
}

// ─── VS Code presence ──────────────────────────────────────────────────────────────────────────────────────────

/** A harness found in one VS Code window. Windows report only what is installed and enabled. */
export const InstalledEngineSchema = z.object({
  engine: HarnessIdSchema,
  /** Older extensions report every known harness with a flag; newer ones send installed ones only. */
  installed: z.boolean().default(true),
  version: z.string().max(40).nullable(),
  label: z.string().max(80).optional(),
  extensionId: z.string().max(120).nullable().optional(),
  tier: z.enum(HARNESS_TIERS).optional(),
})
export type InstalledEngine = z.infer<typeof InstalledEngineSchema>

/** A connected VS Code window, reported by the extension's heartbeat. */
export const ClientPresenceInputSchema = z.object({
  kind: z.literal('vscode'),
  version: z.string().max(40),
  engines: z.array(InstalledEngineSchema).max(30),
  workspace: z
    .object({
      remoteUrl: z.string().max(500).nullable(),
      branch: z.string().max(250).nullable(),
      /** The workspace folder name, to tell windows apart. */
      name: z.string().max(200).nullable().optional(),
    })
    .nullable(),
})
export type ClientPresenceInput = z.infer<typeof ClientPresenceInputSchema>

export const ClientPresenceSchema = ClientPresenceInputSchema.extend({
  clientId: z.string(),
  lastSeenAt: z.string(),
  /** Seen within the last 3 minutes. */
  online: z.boolean(),
})
export type ClientPresence = z.infer<typeof ClientPresenceSchema>

/** How long after its last heartbeat a client still counts as online. */
export const PRESENCE_ONLINE_MS = 3 * 60_000

export const MySettingsSchema = z.object({
  preferences: UserPreferencesSchema,
  clients: z.array(ClientPresenceSchema),
})
export type MySettings = z.infer<typeof MySettingsSchema>

// ─── What a user can start a run in right now ─────────────────────────────────────────────────────────────────

export const StartableHarnessSchema = z.object({
  engine: HarnessIdSchema,
  label: z.string(),
  tier: z.enum(HARNESS_TIERS),
  /** Highest version seen across the user's windows. */
  version: z.string().nullable(),
  /** Online VS Code windows that have it installed. */
  clientIds: z.array(z.string()),
})
export type StartableHarness = z.infer<typeof StartableHarnessSchema>

/**
 * Harnesses installed in the user's ONLINE VS Code windows that the project allows, best tier first. This is the
 * only list the UIs offer when starting a run: nothing that is not installed is ever shown.
 */
export function startableHarnesses(clients: readonly ClientPresence[], project: ProjectSettings | null | undefined): StartableHarness[] {
  const allowed = (project ?? DEFAULT_PROJECT_SETTINGS).allowedEngines
  const byId = new Map<string, StartableHarness>()
  for (const c of clients) {
    if (!c.online) continue
    for (const e of c.engines) {
      if (e.installed === false || !isHarnessAllowed(e.engine, allowed)) continue
      const known = knownHarness(e.engine)
      const entry =
        byId.get(e.engine) ??
        ({ engine: e.engine, label: e.label ?? harnessLabel(e.engine), tier: e.tier ?? known?.tier ?? 'files', version: null, clientIds: [] } as StartableHarness)
      if (!entry.clientIds.includes(c.clientId)) entry.clientIds.push(c.clientId)
      if (e.version && (!entry.version || compareVersions(e.version, entry.version) > 0)) entry.version = e.version
      byId.set(e.engine, entry)
    }
  }
  const rank = (t: HarnessTier) => HARNESS_TIERS.indexOf(t)
  return [...byId.values()].sort((a, b) => rank(a.tier) - rank(b.tier) || a.label.localeCompare(b.label))
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
