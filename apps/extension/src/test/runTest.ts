// Test launcher — runs *outside* VS Code. Downloads (or reuses) a VS Code build,
// then boots it with this extension loaded and points it at the Mocha runner.
//
// Two Windows-specific hazards are handled here:
//
//  1. ELECTRON_RUN_AS_NODE — VS Code's integrated terminal (and other Electron
//     hosts) export this. If inherited, the spawned Code.exe boots as plain Node
//     and rejects every VS Code flag ("bad option: --no-sandbox", etc.). We clear
//     it so the child launches as the actual VS Code app.
//
//  2. Spaces in the project path — @vscode/test-electron spawns with shell:true
//     and does NOT quote individual args, so a path ARG VALUE containing a space
//     (e.g. "...\Ofc Projects\...") gets word-split and truncated. We expose the
//     project through a space-free directory JUNCTION (no admin, no copy — same
//     files and node_modules) and use junction paths for the dev/test args, plus
//     a space-free temp dir for the user-data/extensions profile.
//
//  3. "Error mutex already exists" — the downloaded build ships
//     product.json#win32MutexName = "vscode", the SAME name a normally-installed
//     VS Code uses. When the test host boots while the developer's editor is open,
//     VS Code's installMutex() can't create the already-held global "vscode" mutex
//     and logs an error. The single-instance guard is meaningless for an isolated
//     test profile, so we blank win32MutexName in the cached build's product.json;
//     installMutex() then short-circuits (`if (win32 && name)`) and never collides.
//
//  4. The vscode:// link handler — on Windows every launch of a VS Code build registers
//     it as the current user's handler for product.json#urlProtocol ("vscode"). Left
//     alone, the test build took over vscode:// links, so "Open VS Code" in the
//     platform's web app launched this bare test copy instead of the developer's
//     editor. The cached build gets its own protocol name, so it never touches vscode://.

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron'

const root = path.resolve(__dirname, '..', '..')

/** URL protocol the test build registers instead of `vscode` (hazard 4). */
const TEST_URL_PROTOCOL = 'vscode-sdlc-test'

/**
 * Patch the downloaded build's product.json: blank `win32MutexName` so the isolated
 * test host doesn't try (and fail) to install the global single-instance mutex, and
 * rename `urlProtocol` so it never registers itself as the vscode:// link handler.
 * Best-effort and idempotent: any failure is swallowed.
 */
function isolateTestBuild(vscodeExePath: string): void {
  if (process.platform !== 'win32') {
    return
  }
  try {
    const buildDir = path.dirname(vscodeExePath)
    // The archive build nests resources under a commit-hash dir, so check both the
    // flat layout and one level down.
    const candidates = [
      path.join(buildDir, 'resources', 'app', 'product.json'),
      ...fs
        .readdirSync(buildDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(buildDir, e.name, 'resources', 'app', 'product.json')),
    ]
    const productPath = candidates.find((p) => fs.existsSync(p))
    if (!productPath) {
      return
    }
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8'))
    if (product.win32MutexName || product.urlProtocol !== TEST_URL_PROTOCOL) {
      product.win32MutexName = ''
      product.urlProtocol = TEST_URL_PROTOCOL
      fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'))
    }
  } catch {
    /* best-effort patch — never let it break the test run */
  }
}

/** Create a space-free junction to `target`; returns the junction path (or target if not needed). */
function makeSpaceFreeRoot(target: string): { runRoot: string; junction?: string } {
  if (process.platform !== 'win32' || !target.includes(' ')) {
    return { runRoot: target }
  }
  const junction = path.join(os.tmpdir(), 'sdlcgov-test-link')
  removeJunction(junction)
  // `mklink /J` creates a directory junction without requiring administrator rights.
  execFileSync('cmd', ['/c', 'mklink', '/J', junction, target], { stdio: 'ignore' })
  return { runRoot: junction, junction }
}

/** Remove ONLY the junction reparse point (never the target contents). */
function removeJunction(junction: string): void {
  try {
    // `rmdir` (no /S) on a junction deletes the link, leaving the target intact.
    execFileSync('cmd', ['/c', 'rmdir', junction], { stdio: 'ignore' })
  } catch {
    /* not present — fine */
  }
}

async function main(): Promise<void> {
  // (1) Ensure the child launches as VS Code, not as Node.
  delete process.env.ELECTRON_RUN_AS_NODE

  // `--keep-open` (via `npm run test:open`) tells the in-host runner to leave the
  // window open after the suite finishes, for manual testing. We forward it as an
  // env var into the extension host, where index.ts#run() reads it.
  const keepOpen = process.argv.includes('--keep-open')

  // (2) Space-free paths for every unquoted arg value.
  const { runRoot, junction } = makeSpaceFreeRoot(root)
  const profileDir = path.join(os.tmpdir(), 'sdlcgov-test-profile') // tmpdir has no space here
  // cachePath -> the real .vscode-test; the executable path is quoted by
  // test-electron, so a spaced exe path is safe (only arg VALUES are the hazard).
  const cachePath = path.join(root, '.vscode-test')

  try {
    // Resolve (download/reuse) the build up front so we can patch its product.json
    // before the host boots, then hand the same executable to runTests.
    const vscodeExecutablePath = await downloadAndUnzipVSCode({ cachePath })
    isolateTestBuild(vscodeExecutablePath)

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: runRoot,
      extensionTestsPath: path.join(runRoot, 'out', 'test', 'index.js'),
      cachePath,
      // Providing these suppresses test-electron's auto-added defaults, whose
      // values derive from a fixed spaced path and would be word-split.
      launchArgs: [
        `--user-data-dir=${path.join(profileDir, 'user-data')}`,
        `--extensions-dir=${path.join(profileDir, 'extensions')}`,
      ],
      extensionTestsEnv: keepOpen ? { SDLC_KEEP_OPEN: '1' } : undefined,
    })
  } catch (err) {
    console.error('Failed to run integration tests:', err)
    process.exitCode = 1
  } finally {
    if (junction) {
      removeJunction(junction)
    }
  }
}

void main()
