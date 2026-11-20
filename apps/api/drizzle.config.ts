import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: ['./src/db/schema.ts', './src/db/boardsSchema.ts', './src/db/chatSchema.ts', './src/db/profileSchema.ts', './src/db/embeddingSchema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://sdlc:sdlc_dev_password@127.0.0.1:5432/sdlc',
  },
})
