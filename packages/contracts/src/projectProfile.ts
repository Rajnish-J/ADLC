// The project profile: what the project is, its stack and architecture, how it's going, how to work on it. The
// built-in "Project profiler" agent writes it from the linked repository; after runs that change code it drafts an
// updated version as a proposal a lead accepts. Every version is kept. The accepted one is given to every agent.

import { z } from 'zod'
import { UserSchema } from './schemas'

export const PROFILE_SECTION_KEYS = ['overview', 'techStack', 'architecture', 'status', 'developerGuide', 'integrations'] as const
export type ProfileSectionKey = (typeof PROFILE_SECTION_KEYS)[number]

export const PROFILE_SECTION_LABELS: Record<ProfileSectionKey, string> = {
  overview: 'Overview',
  techStack: 'Tech stack',
  architecture: 'Architecture',
  status: 'Status & delivery health',
  developerGuide: 'Developer guide',
  integrations: 'Integrations, CI/CD & risks',
}

export const PROFILE_MATURITIES = ['prototype', 'active', 'stable', 'maintenance'] as const
export type ProfileMaturity = (typeof PROFILE_MATURITIES)[number]

export const PROFILE_STATUSES = ['generating', 'proposed', 'accepted', 'rejected', 'superseded', 'failed'] as const
export type ProfileStatus = (typeof PROFILE_STATUSES)[number]

/** Why a version exists: someone generated it, or runs changed the code since the accepted one. */
export const PROFILE_TRIGGERS = ['manual', 'run'] as const
export type ProfileTrigger = (typeof PROFILE_TRIGGERS)[number]

export const ProfileSectionSchema = z.object({
  /** Markdown body (no heading — the UI and the rendered document add it). */
  markdown: z.string().max(12_000),
  /** Repository paths the section is based on. */
  sources: z.array(z.string().max(500)).max(20),
})
export type ProfileSection = z.infer<typeof ProfileSectionSchema>

export const ProfileSectionsSchema = z.object({
  overview: ProfileSectionSchema,
  techStack: ProfileSectionSchema,
  architecture: ProfileSectionSchema,
  status: ProfileSectionSchema,
  developerGuide: ProfileSectionSchema,
  integrations: ProfileSectionSchema,
})
export type ProfileSections = z.infer<typeof ProfileSectionsSchema>

/** Counted from the repository, not written by the model: shown as chips. */
export const ProfileStackSchema = z.object({
  languages: z.array(z.object({ name: z.string(), files: z.number().int(), percent: z.number() })),
  frameworks: z.array(z.string()),
  packageManagers: z.array(z.string()),
  /** Workspaces / apps found from manifests (path → name). */
  modules: z.array(z.object({ path: z.string(), name: z.string(), kind: z.string() })),
})
export type ProfileStack = z.infer<typeof ProfileStackSchema>

export const ProfileChangeSchema = z.object({
  at: z.string(),
  runId: z.string().uuid().nullable(),
  summary: z.string(),
})
export type ProfileChange = z.infer<typeof ProfileChangeSchema>

export const ProfileContentSchema = z.object({
  /** One sentence: what the project is. */
  headline: z.string(),
  maturity: z.enum(PROFILE_MATURITIES),
  sections: ProfileSectionsSchema,
  stack: ProfileStackSchema,
  /** Newest first: what changed the profile (runs folded in, regenerations). */
  changelog: z.array(ProfileChangeSchema),
})
export type ProfileContent = z.infer<typeof ProfileContentSchema>

export const ProjectProfileSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  status: z.enum(PROFILE_STATUSES),
  trigger: z.enum(PROFILE_TRIGGERS),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  /** null while generating or when generation failed. */
  content: ProfileContentSchema.nullable(),
  /** The full document as Markdown (what agents and the download get). */
  markdown: z.string(),
  /** False when no AI model was configured: the profile holds only what could be counted from the repository. */
  aiWritten: z.boolean(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  /** The runs a run-triggered proposal folds in. */
  runIds: z.array(z.string().uuid()),
  basedOnId: z.string().uuid().nullable(),
  createdBy: UserSchema.nullable(),
  decidedBy: UserSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionComment: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  actions: z.object({ canEdit: z.boolean(), canDecide: z.boolean() }),
})
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>

/** GET /projects/:key/profile — the accepted profile, the open proposal and whether one is being written. */
export const ProjectProfileStateSchema = z.object({
  current: ProjectProfileSchema.nullable(),
  /** A run-triggered update waiting for review, or a generation in progress / failed. */
  pending: ProjectProfileSchema.nullable(),
  canGenerate: z.boolean(),
  aiEnabled: z.boolean(),
  aiReason: z.string().nullable(),
  /** Whether the project has a linked repository to generate from. */
  hasRepository: z.boolean(),
})
export type ProjectProfileState = z.infer<typeof ProjectProfileStateSchema>

export const ProfileVersionSummarySchema = ProjectProfileSchema.pick({
  id: true,
  version: true,
  status: true,
  trigger: true,
  branch: true,
  commitSha: true,
  aiWritten: true,
  runIds: true,
  createdBy: true,
  decidedBy: true,
  createdAt: true,
  decidedAt: true,
})
export type ProfileVersionSummary = z.infer<typeof ProfileVersionSummarySchema>

export const GenerateProfileInputSchema = z.object({
  /** The branch to read; the repository's default branch when omitted. */
  branch: z.string().trim().min(1).max(250).optional(),
})
export type GenerateProfileInput = z.infer<typeof GenerateProfileInputSchema>

export const DecideProfileInputSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  comment: z.string().trim().max(2_000).optional(),
})
export type DecideProfileInput = z.infer<typeof DecideProfileInputSchema>

/** A curator's edit of a pending proposal (or the accepted profile) before or after accepting it. */
export const UpdateProfileInputSchema = z.object({
  headline: z.string().trim().min(1).max(400).optional(),
  maturity: z.enum(PROFILE_MATURITIES).optional(),
  sections: z.record(z.enum(PROFILE_SECTION_KEYS), z.object({ markdown: z.string().max(12_000) })).optional(),
})
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>

/** Render a profile as one Markdown document. Pure — shared by the API (agents, download) and the clients. */
export function renderProfileMarkdown(projectName: string, content: ProfileContent, meta?: { branch?: string | null; version?: number }): string {
  const lines: string[] = [`# ${projectName} — project profile`, '', `> ${content.headline}`, '']
  const facts = [`Maturity: ${content.maturity}`]
  if (meta?.branch) facts.push(`Branch: ${meta.branch}`)
  if (meta?.version) facts.push(`Version: ${meta.version}`)
  lines.push(facts.join(' · '), '')
  if (content.stack.languages.length) {
    lines.push(`**Languages:** ${content.stack.languages.slice(0, 8).map((l) => `${l.name} ${l.percent}%`).join(', ')}`)
  }
  if (content.stack.frameworks.length) lines.push(`**Frameworks:** ${content.stack.frameworks.join(', ')}`)
  if (content.stack.packageManagers.length) lines.push(`**Package managers:** ${content.stack.packageManagers.join(', ')}`)
  lines.push('')
  for (const key of PROFILE_SECTION_KEYS) {
    const section = content.sections[key]
    lines.push(`## ${PROFILE_SECTION_LABELS[key]}`, '', section.markdown.trim() || '_Nothing recorded yet._', '')
  }
  if (content.changelog.length) {
    lines.push('## Recent changes', '')
    for (const c of content.changelog.slice(0, 15)) lines.push(`- ${c.at.slice(0, 10)} — ${c.summary}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
