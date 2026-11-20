// The chat's model: Azure OpenAI on the Responses API (v1 surface). Configured entirely from the environment —
// see config.ts. When it isn't configured, chat is reported as disabled instead of failing at startup.

import { randomBytes } from 'node:crypto'
import { createAzure, type AzureOpenAIProvider } from '@ai-sdk/azure'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { ChatModelSchema, type ChatConfig, type ChatModel } from '@sdlc/contracts'
import type { Config } from '../config'

export interface ChatRuntime {
  config: ChatConfig
  maxSteps: number
  approvalSecret: string
  /** The model for a deployment id; unknown ids fall back to the default. Throws when chat is disabled. */
  model(id: string | null | undefined): { model: LanguageModel; info: ChatModel }
}

/**
 * `{baseURL}` for the v1 surface. A URL already on `/openai/v1` or a Foundry project endpoint is used as-is;
 * a bare resource root (or `…/openai`) is moved onto `/openai/v1`, the only surface Azure serves Responses on.
 */
export function resolveAzureBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const { pathname } = new URL(trimmed)
  if (/\/openai\/v1$/i.test(pathname) || pathname.startsWith('/api/projects/')) return trimmed
  return trimmed.endsWith('/openai') ? `${trimmed}/v1` : `${trimmed}/openai/v1`
}

function parseModels(config: Config): ChatModel[] {
  if (config.CHAT_MODELS) {
    const parsed = z.array(ChatModelSchema).min(1).safeParse(JSON.parse(config.CHAT_MODELS))
    if (!parsed.success) throw new Error(`CHAT_MODELS is not a valid list of {id, label, contextWindow}: ${parsed.error.issues[0]?.message}`)
    return parsed.data
  }
  return [{ id: config.AZURE_DEPLOYMENT_NAME, label: config.AZURE_DEPLOYMENT_NAME, contextWindow: config.CHAT_CONTEXT_WINDOW }]
}

export function createChatRuntime(config: Config): ChatRuntime {
  const models = parseModels(config)
  const defaultModel = models.find((m) => m.id === config.CHAT_DEFAULT_MODEL)?.id ?? models[0].id
  let provider: AzureOpenAIProvider | null = null
  let reason: string | null = null
  if (!config.AZURE_OPENAI_API_KEY) reason = 'Chat is not configured: set AZURE_OPENAI_API_KEY (and AZURE_OPENAI_BASE_URL) for the API.'
  else if (!config.AZURE_OPENAI_BASE_URL && !config.AZURE_OPENAI_RESOURCE_NAME) reason = 'Chat is not configured: set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME for the API.'
  else {
    provider = createAzure({
      apiKey: config.AZURE_OPENAI_API_KEY,
      ...(config.AZURE_OPENAI_BASE_URL
        ? { baseURL: resolveAzureBaseUrl(config.AZURE_OPENAI_BASE_URL) }
        : { resourceName: config.AZURE_OPENAI_RESOURCE_NAME }),
    })
  }

  return {
    config: { enabled: provider !== null, reason, models, defaultModel },
    maxSteps: config.CHAT_MAX_STEPS,
    approvalSecret: config.CHAT_APPROVAL_SECRET ?? randomBytes(32).toString('base64'),
    model(id) {
      if (!provider) throw new Error(reason ?? 'Chat is not configured.')
      const info = models.find((m) => m.id === id) ?? models.find((m) => m.id === defaultModel) ?? models[0]
      return { model: provider(info.id), info }
    },
  }
}
