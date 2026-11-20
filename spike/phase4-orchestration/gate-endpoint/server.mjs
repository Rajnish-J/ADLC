// Zero-dependency stub of the P4.3 TS gate endpoint, for the P4.0 spike.
//
// Mimics the contract the real Azure Functions endpoint will expose so we can prove the
// HttpRequestAction -> ConditionGroup halt-on-fail loop end-to-end without standing up Foundry Evals yet.
//
//   POST /gate   body: { sdlcStep: string, output: string | object }
//   -> 200 { pass: boolean, reason: string, perEvaluator: [{ evaluator, score, threshold, pass, reason }] }
//
// Decision rule (stub): fail when the design output contains the word "FAIL" (case-insensitive) or is empty —
// enough to exercise both branches. The real endpoint swaps this for evalClient + decideGate from
// @sdlc/governance-core (see plan P4.3). Run:  node server.mjs   (listens on :7071)
//
// Expose publicly (dev tunnel / ngrok / deploy) and put that URL into the workflow YAML HttpRequestAction.url.

import { createServer } from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 7071

function decide(sdlcStep, output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const empty = text.trim().length === 0
  const sentinel = /fail/i.test(text) // stub trigger to force a blocked run
  const score = empty || sentinel ? 0.4 : 0.9
  const threshold = 0.7
  const pass = score >= threshold
  return {
    pass,
    reason: pass
      ? `all required evaluators passed (stub score ${score} >= ${threshold})`
      : `failed required: task_adherence (stub score ${score} < ${threshold})`,
    perEvaluator: [
      { evaluator: 'task_adherence', score, threshold, required: true, pass },
    ],
    // echoed so the spike operator can confirm the workflow sent the right payload
    received: { sdlcStep, outputPreview: text.slice(0, 120) },
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/gate')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'POST /gate only' }))
    return
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid JSON body' }))
      return
    }
    const result = decide(body.sdlcStep ?? 'unknown', body.output)
    // eslint-disable-next-line no-console
    console.log(`[gate] ${body.sdlcStep ?? '?'} -> pass=${result.pass} (${result.reason})`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  })
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[gate] stub listening on http://localhost:${PORT}/gate`)
  // eslint-disable-next-line no-console
  console.log('[gate] tip: include "FAIL" in the design output (or empty) to force a blocked run.')
})
