import { existsSync } from 'fs'
import path from 'path'
import type { NextConfig } from 'next'

// The monorepo root (npm run dev -w @sdlc/web runs with cwd = apps/web), so Next can follow the workspace
// links into packages/*.
const monorepoRoot = path.join(process.cwd(), '..', '..')

// One .env for the whole platform: the repository root's (shared with the API and docker-compose). Next has
// already loaded apps/web/.env* by now (and caches that, so @next/env can't add another directory); Node's own
// loader adds the root file without overriding anything already set.
const rootEnvFile = path.join(monorepoRoot, '.env')
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile)

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't write an AGENTS.md into the app: the VS Code extension discovers **/AGENTS.md as agent definitions.
  agentRules: false,
  // Keep the dev-only Next.js indicator away from the sidebar's user menu (bottom-left).
  devIndicators: { position: 'bottom-right' },
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
}

export default nextConfig
