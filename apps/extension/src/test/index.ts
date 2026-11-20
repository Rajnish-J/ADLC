// Mocha test runner — executed *inside* the VS Code extension host.
// @vscode/test-electron calls the exported `run()`; we discover every compiled
// `*.test.js` under this directory and run them through Mocha (tdd UI).

import * as path from 'path'
import * as fs from 'fs'
import Mocha from 'mocha'

function findTestFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findTestFiles(full))
    } else if (entry.name.endsWith('.test.js')) {
      found.push(full)
    }
  }
  return found
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 })
  const testsRoot = __dirname

  // When SDLC_KEEP_OPEN is set (via `npm run test:open`), we leave the VS Code
  // window OPEN after the suite finishes so you can manually click around and
  // test the extension. @vscode/test-electron closes the instance as soon as
  // this promise settles, so to keep the window we deliberately never resolve
  // or reject — the window lives until you close it (or Ctrl+C the terminal).
  const keepOpen = !!process.env.SDLC_KEEP_OPEN

  return new Promise((resolve, reject) => {
    try {
      for (const file of findTestFiles(testsRoot)) {
        mocha.addFile(file)
      }
      mocha.run((failures) => {
        if (keepOpen) {
          console.log(
            failures > 0
              ? `\n⚠ ${failures} test(s) failed — window kept open for inspection. Close it (or Ctrl+C) to finish.`
              : '\n✔ All tests passed — window kept open for manual testing. Close it (or Ctrl+C) to finish.',
          )
          return // never settle: keeps the window alive
        }
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`))
        } else {
          resolve()
        }
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
