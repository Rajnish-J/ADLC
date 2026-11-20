// Self-host Monaco: copy monaco-editor's AMD build (min/vs) into public/monaco/vs so the editor loads from this app
// instead of a CDN. Runs before `next dev` / `next build`; skips the copy when the installed version is already there.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgPath = require.resolve('monaco-editor/package.json')
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'))
const source = join(dirname(pkgPath), 'min', 'vs')
const targetRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'monaco')
const marker = join(targetRoot, 'VERSION')

if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === version) {
  console.log(`monaco-editor ${version} already in public/monaco`)
} else {
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(targetRoot, { recursive: true })
  cpSync(source, join(targetRoot, 'vs'), { recursive: true })
  writeFileSync(marker, `${version}\n`)
  console.log(`Copied monaco-editor ${version} to public/monaco`)
}
