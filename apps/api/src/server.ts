import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildApp } from './app'
import { loadConfig, loadEnvFile } from './config'

// Local settings from apps/api/.env (git-ignored), if present. Variables already set in the environment win.
const ENV_FILE = path.resolve(__dirname, '../.env')
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

async function main(): Promise<void> {
  loadEnvFile()
  const config = loadConfig()
  const app = buildApp(config)

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`)
    await app.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: config.HOST, port: config.PORT })
  if (config.AUTH_MODE === 'dev') {
    app.log.warn('AUTH_MODE=dev: callers choose who they are. Local development only.')
  } else {
    app.log.info(`AUTH_MODE=entra: accepting Microsoft Entra ID access tokens from tenant ${config.ENTRA_TENANT_ID}.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
