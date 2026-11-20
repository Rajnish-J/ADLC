// @sdlc/core/discovery — finds agent and skill definitions (Claude agents and skills, AGENTS.md, agent.yaml,
// Copilot, Cursor rules) in a repository's files. Pure: adapters take (path, text) and never touch the file system
// or execute anything, so the extension (scanning the workspace) and the API (scanning a cloned repo) share them.
// Kept out of the main @sdlc/core entry so the web bundle doesn't pull in js-yaml.

export * from './agentModel'
export * from './frontmatter'
export * from './validator'
export * from './dedupe'
export * from './normalize'
export * from './suggestions'
export * from './adapters'
export type { DiscoveryAdapter } from './adapters/types'
export { claudeAgentAdapter, fallbackName } from './adapters/claudeAgent'
export { claudeSkillAdapter } from './adapters/claudeSkill'
export { agentsMdAdapter } from './adapters/agentsMd'
export { agentYamlAdapter } from './adapters/agentYaml'
export { copilotAdapter } from './adapters/copilot'
export { copilotAgentAdapter } from './adapters/copilotAgent'
export { cursorRulesAdapter } from './adapters/cursorRules'
export * from './builtinAgents'
