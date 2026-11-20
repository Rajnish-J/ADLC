// esbuild bundler for the VS Code extension.
// Bundles src/extension.ts -> dist/extension.js as a CommonJS Node module,
// keeping the `vscode` module external (provided by the host at runtime).
const esbuild = require('esbuild')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

// Emits the exact markers the VS Code `$esbuild-watch` problem matcher waits on
// (`tasks.json`). Without `[watch] build started` / `[watch] build finished`,
// VS Code can never tell that the background pre-launch build is ready, so the
// F5 debug launch races the build and the Extension Development Host often opens
// then closes immediately. We print the markers AND surface build errors.
/** @type {import('esbuild').Plugin} */
const watchMarkerPlugin = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started')
    })
    build.onEnd((result) => {
      for (const e of result.errors) {
        const loc = e.location
        if (loc) {
          console.error(`✘ [ERROR] ${e.text}\n    ${loc.file}:${loc.line}:${loc.column}`)
        } else {
          console.error(`✘ [ERROR] ${e.text}`)
        }
      }
      console.log('[watch] build finished')
    })
  },
}

/** The extension host bundle — CommonJS Node module. @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Heavy/preview deps are optionalDependencies + lazy-imported. Keep them
  // external so a slim install stays small and a missing package degrades
  // gracefully (fetch fallback / telemetry-off) instead of failing the bundle.
  external: [
    'vscode',
    '@azure/identity',
    '@azure/ai-projects',
    'openai',
    '@azure/monitor-opentelemetry-exporter',
    '@opentelemetry/api',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-trace-base',
  ],
  sourcemap: !production,
  minify: production,
  // 'warning' not 'info': esbuild's info-level build SUMMARY goes to stderr, and
  // under PowerShell `npm.ps1` re-wraps any native stderr as a red
  // `NativeCommandError` — making a SUCCESSFUL build look like a crash. Warnings
  // and real errors still surface; the noisy summary that triggered the red text
  // is gone. Our own `[esbuild] build complete` line on stdout signals success.
  logLevel: 'warning',
  plugins: watch ? [watchMarkerPlugin] : [],
}

// The Phase-5 canvas webview bundle — a browser ESM module loaded inside a
// sandboxed WebviewPanel. React + React Flow + Dagre are bundled IN (not
// external) because the webview has no Node module resolution. Output lands in
// dist/webview/ which the VSIX must ship (see .vscodeignore).
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['src/webview/ui/main.tsx'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  sourcemap: !production,
  minify: production,
  // See note above: 'warning' avoids the misleading red NativeCommandError under
  // PowerShell while still surfacing genuine build warnings and errors.
  logLevel: 'warning',
  // `process.env.NODE_ENV` is referenced by React's dev/prod branches.
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
}

/** The Story panel webview (a platform story: overview, memory, code activity). Same browser setup as the canvas. @type {import('esbuild').BuildOptions} */
const storyWebviewOptions = {
  ...webviewOptions,
  entryPoints: ['src/webview/story/main.tsx'],
  outfile: 'dist/webview/story.js',
}

/** The Chat panel webview (the platform's specialist assistants). Same browser setup as the canvas. @type {import('esbuild').BuildOptions} */
const chatWebviewOptions = {
  ...webviewOptions,
  entryPoints: ['src/webview/chat/main.tsx'],
  outfile: 'dist/webview/chat.js',
}

async function buildOne(opts) {
  if (watch) {
    const ctx = await esbuild.context(opts)
    await ctx.watch()
  } else {
    await esbuild.build(opts)
  }
}

// The built-in agents (packages/core/agents/*.md) the default "Story delivery" workflow binds by slug. Copied next
// to the bundle so the extension resolves them offline (src/runtime/builtinAgentRegistry.ts).
function copyBuiltinAgents() {
  const fs = require('fs')
  const path = require('path')
  const src = path.join(path.dirname(require.resolve('@sdlc/core/package.json')), 'agents')
  const dest = path.join(__dirname, 'dist', 'agents')
  fs.mkdirSync(dest, { recursive: true })
  for (const f of fs.readdirSync(src)) if (f.endsWith('.md')) fs.copyFileSync(path.join(src, f), path.join(dest, f))
}

async function main() {
  copyBuiltinAgents()
  await Promise.all([buildOne(extensionOptions), buildOne(webviewOptions), buildOne(storyWebviewOptions), buildOne(chatWebviewOptions)])
  if (watch) {
    console.log('[esbuild] watching for changes…')
  } else {
    console.log('[esbuild] build complete')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
