// P4.0 spike runner skeleton — drives a declarative workflow run against a live Foundry project
// and prints the lifecycle so the operator can answer Unknowns A/B/C (see README).
//
// THIS IS A SKELETON. The exact "register + run a declarative workflow" surface is the spike's
// open question (Unknown A). Two code paths are stubbed below; the operator fills in whichever the
// project actually supports, then records the working endpoints + api-version in the ADR.
//
// Env:
//   FOUNDRY_PROJECT_ENDPOINT  e.g. https://<project>.services.ai.azure.com/api/projects/<name>
//   FOUNDRY_TOKEN             bearer for https://ai.azure.com/.default
//                             (az account get-access-token --resource https://ai.azure.com)
//   WORKFLOW_AGENT_NAME       the registered workflow-agent name (if Unknown A == A1)
//   API_VERSION               the api-version that works for this project (capture it!)

const endpoint = req('FOUNDRY_PROJECT_ENDPOINT')
const token = req('FOUNDRY_TOKEN')
const apiVersion = process.env.API_VERSION ?? '2025-05-01' // TODO(spike): confirm the real value
const workflowAgent = process.env.WORKFLOW_AGENT_NAME ?? 'sdlc-gate-hitl-spike'

function req(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env: ${name}`)
    process.exit(2)
  }
  return v
}

async function api(method, path, body) {
  const url = `${endpoint}${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  console.log(`${method} ${path} -> ${res.status}`)
  return { status: res.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Path A1: Foundry runs the workflow server-side via threads/runs (the plan's assumption) -----
async function runViaRest() {
  // 1) Create a conversation/thread.
  const thread = await api('POST', '/threads', {})
  const threadId = thread.json.id
  if (!threadId) throw new Error('no thread id — wrong endpoint/api-version? (Unknown A)')

  // 2) Seed the task message.
  await api('POST', `/threads/${threadId}/messages`, {
    role: 'user',
    content: 'Design a rate limiter for the public API.',
  })

  // 3) Start a run against the workflow agent (registered from the YAML).
  const run = await api('POST', `/threads/${threadId}/runs`, { assistant_id: workflowAgent })
  const runId = run.json.id
  if (!runId) throw new Error('no run id — is the workflow registered as a runnable agent? (Unknown A)')

  // 4) Poll. Watch for terminal states AND requires_action (Unknown B — does HITL surface here?).
  let delay = 800
  for (let i = 0; i < 40; i++) {
    const status = await api('GET', `/threads/${threadId}/runs/${runId}`)
    const s = status.json.status
    console.log(`  run status: ${s}`)
    if (s === 'requires_action') {
      console.log('  >>> requires_action payload (capture this — is it the Question HITL?):')
      console.log(JSON.stringify(status.json.required_action, null, 2))
      // TODO(spike): respond per whatever protocol applies (submit_tool_outputs? a workflow-specific resume?).
      break
    }
    if (['completed', 'failed', 'cancelled', 'expired'].includes(s)) {
      console.log('  >>> terminal. Messages:')
      const msgs = await api('GET', `/threads/${threadId}/messages`)
      console.log(JSON.stringify(msgs.json, null, 2))
      break
    }
    await sleep(delay)
    delay = Math.min(delay * 1.5, 5000)
  }

  // 5) Cancel probe (run a second time and cancel mid-flight to verify the verb).
  // await api('POST', `/threads/${threadId}/runs/${runId}/cancel`)
}

// --- Path A2: declarative workflows only run in-process via the prerelease SDK -------------------
function runViaSdkNote() {
  console.log(`
[A2] If /threads returns 404 or the workflow won't register/run via REST, the declarative engine is
     likely in-process only. Run it with the prerelease SDK instead and record that in the ADR:

  Python:  pip install agent-framework-declarative --pre
           factory = WorkflowFactory()
           wf = factory.create_workflow_from_yaml_path("workflow.gate-hitl.python.yaml")
           result = await wf.run({"task": "Design a rate limiter for the public API."})
           # HITL surfaces as RequestInfoEvent; respond via run.send_response(...)

  C#:      dotnet add package Microsoft.Agents.AI.Workflows.Declarative --prerelease
           var wf = DeclarativeWorkflowBuilder.Build<string>("workflow.gate-hitl.csharp.yaml", options);
           await InProcessExecution.RunStreamingAsync(wf, input, checkpointManager);

     -> This means the HOST must be a small Python/C# runner, not pure REST. Flag to the user before P4.2.
`)
}

;(async () => {
  console.log(`Spike against ${endpoint} (api-version=${apiVersion}, workflow=${workflowAgent})`)
  try {
    await runViaRest()
  } catch (e) {
    console.error(`REST path failed: ${e.message}`)
    runViaSdkNote()
    process.exitCode = 1
  }
})()
