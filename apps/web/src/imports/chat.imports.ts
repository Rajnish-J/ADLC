// The chat page's types, services, hooks and sub-components, imported by ChatContainer as `* as C`.

export type {
  AskUserOutput,
  ChatAgentSummary,
  ChatConfig,
  ChatDraft,
  ChatThreadSummary,
  ChatToolInfo,
  HandoffInput,
  ProjectSummary,
} from '@sdlc/contracts'

export { deleteThread, getChatConfig, listChatAgents, listChatTools, listThreads } from '@/service/chat.service'
export { listProjects } from '@/service/project.service'

export { useApiResource } from '@/hooks/common/useApiResource'
export { useChatPreferences, type ChatPreferences } from '@/hooks/chat/useChatPreferences'
export { useChatSession } from '@/hooks/chat/useChatSession'
export { useDictation, useReadAloud } from '@/hooks/chat/useVoice'

export { default as ChatMessage } from '@/components/chat/ChatMessage'
export { default as PromptInput } from '@/components/chat/PromptInput'
export { default as SelectAgent } from '@/components/chat/SelectAgent'
export { default as ToolsPill } from '@/components/chat/ToolsPill'
export { default as DraftStepper } from '@/components/chat/DraftStepper'
export { default as DraftReviewSheet } from '@/components/chat/DraftReviewSheet'
export { ContextUsageRing, ProjectChip, SelectModel, ToolModeDropdown } from '@/components/chat/ComposerControls'
export { ChatGreeting, ThreadMenu } from '@/components/chat/ChatChrome'
export { contextTokens, messageText } from '@/components/chat/chatHelpers'
