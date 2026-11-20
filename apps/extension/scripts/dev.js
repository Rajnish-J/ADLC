// Launch a PERSISTENT VS Code window with this extension loaded in development
// mode. Unlike `npm test` (which runs headless and closes itself), this window
// stays open so you can click the SDLC Governance view, sign in, etc.
//
// THE WINDOWS GOTCHA THIS SOLVES ("window opens then closes suddenly")
// --------------------------------------------------------------------
// `npm run dev` runs this script inside a Windows *job object* that kills every
// child process when the launching command exits. A normal Node "detached"
// spawn (detached:true + unref) does NOT break out of that job — so the instant
// `npm run dev` returns, the job tears the freshly-opened VS Code window down.
//
// The only thing that reliably escapes a kill-on-close job is a process created
// with CREATE_BREAKAWAY_FROM_JOB. Node doesn't expose that flag, but the cmd
// built-in `start` creates its target exactly that way. So on Windows we launch
// through `cmd /c start`: the window breaks away from the job, survives npm
// exiting, AND your terminal is returned immediately. (Verified: the VS Code
// process tree stays alive after the launcher is gone.)
//
// On macOS/Linux a plain detached+unref spawn already survives, so we use that.
//
// We also clear ELECTRON_RUN_AS_NODE so the child boots as the VS Code app (not
// as plain Node, which would reject every VS Code flag with "bad option").

const path = require('path')
const os = require('os')
const cp = require('child_process')
const { downloadAndUnzipVSCode } = require('@vscode/test-electron')

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE

  const root = path.resolve(__dirname, '..')
  const exe = await downloadAndUnzipVSCode({ cachePath: path.join(root, '.vscode-test') })

  // Isolated, space-free profile so it doesn't collide with your normal VS Code.
  // Stable (not per-run) so an Azure sign-in persists across dev sessions.
  const profile = path.join(os.tmpdir(), 'sdlcgov-dev-profile')
  const args = [
    '--new-window',
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${path.join(profile, 'user-data')}`,
    `--extensions-dir=${path.join(profile, 'extensions')}`,
  ]

  if (process.platform === 'win32') {
    launchWindowsBreakaway(exe, args)
  } else {
    // POSIX: a detached, unref'd child already outlives the launcher.
    cp.spawn(exe, args, { detached: true, stdio: 'ignore', shell: false }).unref()
  }

  console.log('Launched VS Code with the extension in development mode.')
  console.log('Click the shield icon (SDLC Governance) in the Activity Bar to test.')
  console.log('The window stays open until YOU close it — your terminal is free now.')
}

// Launch VS Code so it survives `npm run dev` exiting.
//
// THE RELIABLE WAY: WMI Win32_Process.Create. That call runs inside the WMI
// service host (WmiPrvSE.exe), so the new VS Code process is parented by the
// SERVICE — not by us — and is therefore NOT a member of the kill-on-exit job
// object npm wraps this script in. This survives npm exiting every time.
//
// Why not `cmd /c start`? `start` relies on CREATE_BREAKAWAY_FROM_JOB, which
// only works when the job grants JOB_OBJECT_LIMIT_BREAKAWAY_OK. npm's job often
// does NOT, so the window opens and is then torn down the instant npm exits
// ("Launched..." prints but no window appears). We keep `start` only as a
// fallback for the rare case WMI is unavailable.
function launchWindowsBreakaway(exe, args) {
  if (createViaWmi(exe, args)) return
  const startLine = ['start', '""', `"${exe}"`, ...args.map((a) => `"${a}"`)].join(' ')
  cp.spawn('cmd.exe', ['/c', startLine], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref()
}

// Build a single fully-quoted command line and hand it to Win32_Process.Create
// via PowerShell. Returns true on success (ReturnValue 0). Every token is quoted
// so spaces in the exe path and arg values survive Windows command-line parsing;
// the here-string ('@...@') keeps those quotes and any backslashes literal.
function createViaWmi(exe, args) {
  const cmdline = [exe, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
  const psScript = `$r = ([wmiclass]'Win32_Process').Create(@'\n${cmdline}\n'@); exit [int]$r.ReturnValue`
  const res = cp.spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { stdio: 'ignore' }
  )
  return res.status === 0
}

main().catch((err) => {
  console.error('Failed to launch dev host:', err)
  process.exit(1)
})
