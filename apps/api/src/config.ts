// API configuration from the environment. Defaults match docker-compose.yml / .env.example, so a fresh clone
// runs locally with no .env at all.

import { existsSync } from 'fs'
import path from 'path'
import { z } from 'zod'

/** The repository root's `.env` (shared with the web app and docker-compose). Variables already set win. */
const ROOT_ENV_FILE = path.resolve(__dirname, '../../../.env')

export function loadEnvFile(file = ROOT_ENV_FILE): void {
  if (existsSync(file)) process.loadEnvFile(file)
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default('postgres://sdlc:sdlc_dev_password@127.0.0.1:5432/sdlc'),
  /**
   * `dev`: the caller names a seeded user (x-dev-user header or sdlc_dev_user cookie) — local development only.
   * `entra`: Microsoft Entra ID access tokens (`Authorization: Bearer …`), issued to the web app by MSAL.
   */
  AUTH_MODE: z.enum(['dev', 'entra']).default('dev'),
  /** Entra directory (tenant) id. Only tokens issued by this tenant are accepted. Required when AUTH_MODE=entra. */
  ENTRA_TENANT_ID: z.string().trim().uuid('ENTRA_TENANT_ID must be the directory (tenant) id GUID.').optional(),
  /** Application (client) id of the app registration the access tokens are issued for. Required when AUTH_MODE=entra. */
  ENTRA_CLIENT_ID: z.string().trim().uuid('ENTRA_CLIENT_ID must be the application (client) id GUID.').optional(),
  /**
   * Extra accepted token audiences, comma-separated. Only needed when the API has its own app registration whose
   * Application ID URI differs from `api://<ENTRA_CLIENT_ID>`.
   */
  ENTRA_API_AUDIENCE: z.string().trim().optional(),
  /** Where the web app runs — used to build links (e.g. "open in browser" from the extension). */
  WEB_URL: z.string().default('http://localhost:3000'),
  /**
   * Key that encrypts the repository access tokens (AES-256-GCM): 32 random bytes, base64 — `openssl rand -base64 32`.
   * Required in production; development falls back to a fixed, well-known key.
   */
  REPO_CREDENTIAL_KEY: z.string().optional(),
  /** Where repository clones are made while syncing or committing (always removed afterwards). Default: the OS temp dir. */
  REPO_WORK_DIR: z.string().optional(),
  /** Text files larger than this are listed but their contents aren't stored. */
  REPO_MAX_FILE_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  /** A branch with more files than this (after .gitignore) is refused. */
  REPO_MAX_FILES: z.coerce.number().int().positive().default(50_000),
  /** How many repositories sync at the same time. */
  REPO_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Timeout for one git network operation (clone/fetch/push). */
  REPO_GIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),

  // ─── Orchestrator service (services/orchestrator, Python). Owns the catalog and drives platform runs. ────
  /** Where the orchestrator listens. */
  ORCHESTRATOR_URL: z.string().default('http://127.0.0.1:4100'),
  /** Shared secret on every gateway ↔ orchestrator call (both directions). Required in production. */
  ORCHESTRATOR_TOKEN: z.string().default('dev-orchestrator-token'),

  // ─── Chat (Azure OpenAI). Without a key and an endpoint the Chat page shows "not configured". ─────────
  /** Azure OpenAI API key. */
  AZURE_OPENAI_API_KEY: z.string().optional(),
  /**
   * Endpoint: the v1 surface (`https://<res>.openai.azure.com/openai/v1`, or a Foundry
   * `.services.ai.azure.com/openai/v1` / `/api/projects/<p>` URL) or the bare resource root, which is moved
   * onto `/openai/v1`. Alternatively set AZURE_OPENAI_RESOURCE_NAME.
   */
  AZURE_OPENAI_BASE_URL: z.string().optional(),
  AZURE_OPENAI_RESOURCE_NAME: z.string().optional(),
  /** Deployment used when CHAT_MODELS is not set. */
  AZURE_DEPLOYMENT_NAME: z.string().default('gpt-5.6-sol'),
  /** JSON list of selectable deployments: `[{"id":"<deployment>","label":"GPT-5.6","contextWindow":400000}]`. */
  CHAT_MODELS: z.string().optional(),
  /** Deployment picked by default (an `id` from CHAT_MODELS). */
  CHAT_DEFAULT_MODEL: z.string().optional(),
  /** Context window of AZURE_DEPLOYMENT_NAME when CHAT_MODELS is not set. */
  CHAT_CONTEXT_WINDOW: z.coerce.number().int().positive().default(272_000),
  /** Ceiling on tool-calling steps in one assistant turn (a specialist's own `maxSteps` may be lower). */
  CHAT_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(12),
  /** Signs tool-approval requests so a client can't forge an approval. Random per process when unset. */
  CHAT_APPROVAL_SECRET: z.string().optional(),

  // ─── Memory embeddings (semantic search). Without them memory search stays keyword-only. ─────────────
  /** Endpoint of the embedding deployment (same forms as AZURE_OPENAI_BASE_URL); defaults to the chat endpoint. */
  AZURE_EMBEDDING_BASE_URL: z.string().optional(),
  /** Key for the embedding endpoint; defaults to AZURE_OPENAI_API_KEY. */
  AZURE_EMBEDDING_API_KEY: z.string().optional(),
  /** Embedding deployment name (text-embedding-3-small / -large). */
  AZURE_EMBEDDING_DEPLOYMENT: z.string().optional(),
  /** Vector size stored in pgvector (text-embedding-3 models shorten to it). Must match migration 0022. */
  AZURE_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(env)
  // The dev sign-in lets anyone act as any user. It must never be reachable outside a developer's machine.
  if (config.AUTH_MODE === 'dev' && config.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=dev is refused when NODE_ENV=production. Configure Entra ID authentication.')
  }
  if (config.NODE_ENV === 'production' && !config.REPO_CREDENTIAL_KEY) {
    throw new Error('REPO_CREDENTIAL_KEY is required in production (32 random bytes, base64) — it encrypts repository tokens.')
  }
  if (config.NODE_ENV === 'production' && config.ORCHESTRATOR_TOKEN === 'dev-orchestrator-token') {
    throw new Error('ORCHESTRATOR_TOKEN is required in production — the gateway and the orchestrator share it.')
  }
  if (config.AUTH_MODE === 'entra' && (!config.ENTRA_TENANT_ID || !config.ENTRA_CLIENT_ID)) {
    throw new Error('AUTH_MODE=entra needs ENTRA_TENANT_ID and ENTRA_CLIENT_ID (the app registration in Microsoft Entra ID).')
  }
  return config
}
