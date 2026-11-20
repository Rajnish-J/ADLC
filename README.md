# SDLC platform

A control plane for AI agents across the software development lifecycle. One backend, two clients:

| Path | What it is |
|---|---|
| [`apps/api`](apps/api) | The gateway and platform API (Fastify + Postgres): sign-in, projects, members and roles, user stories, memory, repositories, chat, audit log, live events. Forwards the catalog and run lifecycle to the orchestrator. |
| [`services/orchestrator`](services/orchestrator/README.md) | The orchestrator (Python, FastAPI + LangGraph): the workflow and agent/skill catalog, and the engine that drives platform runs. Every workflow node runs as a LangGraph node; every agent step goes to its harness in your VS Code. |
| [`apps/web`](apps/web) | Next.js web app for admins, owners and leads (and developers): projects, story board, members, agents, workflow canvas, activity. |
| [`apps/extension`](apps/extension/README.md) | The VS Code extension: agent discovery, governed workflow runs, Foundry gates — and the **Platform Stories** view on the same backend. |
| [`packages/core`](packages/core) | The workflow model shared by all three (spec, run types, default workflows, canvas layout). |
| [`packages/contracts`](packages/contracts) | The API contract: request/response schemas, roles and permissions, story rules, live-event types. |

## Run it locally

Prerequisites: Node 20+, Docker Desktop, Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```sh
npm ci              # install every workspace
npm run db:up       # Postgres 16 + pgvector in Docker (127.0.0.1:5432)
npm run db:migrate  # create the tables
npm run db:seed     # demo users, agent catalog, workflows, two demo projects

npm run dev:orchestrator  # orchestrator → http://127.0.0.1:4100 (uv installs its Python dependencies on first run)
npm run dev:api           # gateway      → http://127.0.0.1:4000
npm run dev:web           # web app      → http://localhost:3000   (open this in Chrome)
```

Run `dev:orchestrator`, `dev:api` and `dev:web` in separate terminals. Without the orchestrator, the agents, workflows and runs pages answer "The orchestrator service is not reachable".

**In Chrome:** open <http://localhost:3000> and choose who to sign in as.

**In VS Code:** press **F5** (or `npm run dev`) to launch the extension, open the **SDLC Governance** view, and in **Platform Stories** choose **Connect to the SDLC Platform**. Enter `http://127.0.0.1:4000` and pick a user. Changes made in either place show up in the other immediately.

### Demo users

Sign-in is a local-development stand-in for Microsoft Entra ID: you pick a seeded user. The API refuses this mode when `NODE_ENV=production`.

| User | Role |
|---|---|
| `admin@sdlc.local` — Asha Admin | Org admin: sees every project, creates projects |
| `owner@sdlc.local` — Owen Owner | Owner of Payments Portal (PAY) |
| `lead@sdlc.local` — Leela Lead | Lead on PAY, owner of Customer Onboarding (ONB) |
| `dev1@sdlc.local` — Devi Developer | Developer on PAY |
| `dev2@sdlc.local` — Deepak Developer | Developer on PAY and ONB |
| `viewer@sdlc.local` — Vera Viewer | Viewer on PAY (read-only) |

### Linked repositories (the Code page)

When you create a project, you can link its **GitHub or Azure Repos** repository by entering just its URL. You can also link one later from the project's **Code** page; that needs an owner.

**Access tokens are set up once, in Git connections.** An org admin opens **Git connections** in the sidebar and adds a token:
- **Azure Repos:** one per Azure DevOps organization.
- **GitHub:** one per owner, or one that covers every owner.

The platform then picks the matching connection by itself whenever it clones, syncs or commits:
- **Public repositories** need no connection.
- **Private ones that failed** because no connection matched are retried as soon as one is added.
- **Replacing an expired token** updates every project at once.

**What the platform does with it:**
- **Clones it into Postgres.** It never checks the repository out:
  - It runs `ls-remote` and fetches with `--depth 1` into a temporary bare repository, which is deleted afterwards.
  - Files are filtered by `.gitignore` before anything is read. Nested `.gitignore` files are honoured, and `node_modules/` and `.git/` are never kept.
  - Text files up to 1 MiB are stored, deduplicated by git blob sha across branches.
  - Binary, oversized and non-UTF-8 files are listed but their contents aren't stored. So are files that look like secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, …), whose contents are never stored.
- **Indexes branches when they're needed.** The default branch is indexed when the repository is linked. Any other branch is indexed the first time someone opens it.
- **Shows the code in Monaco, read-only.** Developers and above can:
  1. click **Edit** on a file
  2. **Save** the edit as a private draft (Ctrl+S)
  3. **Review changes**
  4. **Commit**, which pushes straight to the branch they are viewing, authored by them.

  If the file changed on the branch in the meantime, nothing is pushed. The draft is flagged instead, so they can compare it with the latest version and keep or discard their edit. They can also create a branch from the current one.
- **Imports agents and skills from the default branch** into the **Agents** and **Skills** pages. It reads `.claude/agents`, `.claude/skills/*/SKILL.md`, `.github/agents/*.agent.md`, `AGENTS.md`, `agent.yaml`, Copilot instructions and Cursor rules.
  - This uses the same parsers as the extension, now in `@sdlc/core/discovery`.
  - **Sync** refreshes the files, the branches and the catalog.

**Setup on the API host:**
- **git 2.31 or later** must be on the `PATH`.
- **Git connection tokens** (added on the **Git connections** page):
  - Azure Repos: **Code (Read & write)**.
  - GitHub: a fine-grained token with **Contents: read and write**.
  - Read-only scope is enough to browse; committing needs write.
  - Each token is checked with GitHub or Azure DevOps before it is saved.
  - Tokens are encrypted with `REPO_CREDENTIAL_KEY` and never returned. They reach git only through environment variables.

| API variable | Default | |
|---|---|---|
| `REPO_CREDENTIAL_KEY` | development key | 32 random bytes, base64 (`openssl rand -base64 32`). **Required in production.** |
| `REPO_WORK_DIR` | OS temp dir | Where the temporary clones are made. |
| `REPO_MAX_FILE_BYTES` | 1048576 | Larger text files are listed but their contents aren't stored. |
| `REPO_MAX_FILES` | 50000 | A branch with more files than this, after `.gitignore`, is refused. |
| `REPO_JOB_CONCURRENCY` | 2 | Repositories syncing at the same time. |

The web app serves Monaco itself: `predev` and `prebuild` copy it into `apps/web/public/monaco`, and no CDN is used.

### Starting stories and tasks in your harness

A story, or one of its **tasks**, can be started from the web: **Start in VS Code** on the Workflow page, on the story page, or on a task row.
- **Tasks** are native child items of a story, like GitHub issues or Azure Boards Tasks. Each one can link to the issue or work item it mirrors.
- **The harness list** shows only what is installed in your connected VS Code windows (Copilot, Claude Code, Codex, Roo Code, …). The project can limit which harnesses are allowed (owners set this on the Workflow page).
- **Claude Code and Codex come with the extension** as an extension pack, so every developer has them by default. See [INSTALL.md](INSTALL.md#claude-code-and-codex-come-with-it).

**Each step can run in its own harness.** On the Workflow page (or in the extension's workflow view), an agent step can be pinned to a harness — e.g. *Plan* in Claude Code and *Implement* in Copilot. Unpinned steps use the harness you pick when you start. A run only starts if every harness it needs is installed in one of your VS Code windows and allowed by the project.

**What happens when you click Start:**
1. The orchestrator records a run with the status `requested`.
2. Your VS Code hears about it over the live event stream, and the browser opens a `vscode://synergech.sdlc-governance-extension/start?run=…` link. A link alone always asks for confirmation.
3. The first VS Code window that claims the run checks out the story branch and writes a git-ignored session folder (`.sdlc/sessions/<KEY>/`) and each needed harness's MCP and hook config.
4. The orchestrator runs the workflow on the server as a LangGraph graph (checkpointed in Postgres). When it reaches an agent step it hands the step to that step's harness; VS Code opens the harness when its first step arrives.
5. The harness calls the SDLC tools on a local, loopback-only MCP server, which forwards them to the platform: `sdlc_next_step`, `sdlc_submit_plan`, `sdlc_complete_step` (with optional `outputs` that later conditions can branch on), and the memory tools. When the next step belongs to another harness it is told to hand off and stop.
6. Plans and approval steps are decided **on the web** (run details → Approve / Reject) or from the VS Code notification. Gates run on the server.

A request that no window claims within 2 minutes expires. A run survives an orchestrator restart: it continues from its last checkpoint. Runs started with the extension's built-in runtime (or signed out) still run locally in VS Code.

**What is recorded and shown on the web and in the extension:**
- runs: harness, model, task and who requested it
- steps: agent, skills bound and used, tool calls, plan and output
- every evaluator verdict (`run_evaluations`): score, threshold, required or advisory, reason, dataset counts, judge tokens
- an activity log (`run_events`): agents, skills, tool calls, files, memory, approvals.

**How much a harness reports:**

| Detail | Harnesses | What you get |
|---|---|---|
| Full detail | Copilot, Claude Code | Checkpoint tools and hooks |
| Checkpoints | Codex, Roo Code, Kilo Code | Checkpoint tools only |
| Basic | Others, and any added under `sdlcGovernance.harnesses.custom` | Checkpoints through files; the prompt is copied for you to paste |

**Still to verify in a real VS Code** (not tested yet):
- Which VS Code version is needed for Copilot to pick up the MCP server.
- Whether Codex reads the project's `.codex/config.toml`.
- Whether Claude Code accepts the hook settings without asking.
- How long each harness waits on a tool call.

### Chat (specialist assistants)

**Chat** in the sidebar (and **SDLC Platform: Open Chat** in VS Code) talks to the platform through assistants:

| Assistant | What it does |
|---|---|
| Default | Answers questions across your projects, and hands off to a specialist when you want to build or change something |
| Workflows | Designs new delivery workflows and registers them; maps agents and skills onto steps; picks the default workflow |
| Projects | Sets up projects (blank workspace or imported repository); manages members and archiving |
| Agents | Writes agent definitions (role, procedure, tools, guardrails); edits platform agents; turns agents on or off |
| Skills | Writes skills (SKILL.md procedures) and attaches them to workflow steps |
| Stories & Issues | Turns a feature into stories with acceptance criteria and tasks; edits, assigns and moves stories |
| Memory | Records and curates project and story memory |
| Runs | Starts a story in your VS Code harness, follows runs, explains failures, cancels runs |
| Portfolio | Read-only overview across projects: what is blocked, overdue or unassigned, and what to do next |
| Repos & Connections | Links and syncs repositories and checks Git connections. Never handles tokens. |

**How changes happen:**
- **Building something new:** the specialist asks questions and keeps a **draft**. You open it with **Review & submit**, edit anything, and submit. Only then is it created, as you.
- **Changing something that exists:** every change the assistant wants to make shows an **Approve / Reject** card first. The AI SDK enforces this, so the model can't skip it.
- **Permissions:** the assistant acts with your role, and tools your role can't use are not offered. The audit log records the change with `via: web:chat` or `extension:chat`.
- **Platform agents and skills:** ones created in chat are stored on the platform (source `platform`). They appear on the Agents and Skills pages next to the built-in and repository ones.

**Setup:** give the API process the Azure OpenAI settings below as environment variables. For local development, set them in the shell that runs `npm run dev:api`; the API does not read `.env` files itself. Without them, the Chat page says it is not configured.

| API variable | Default | |
|---|---|---|
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key. |
| `AZURE_OPENAI_BASE_URL` | — | `https://<resource>.openai.azure.com/openai/v1`, a Foundry `/openai/v1` or `/api/projects/<p>` URL, or the bare resource root (moved onto `/openai/v1`). Or set `AZURE_OPENAI_RESOURCE_NAME`. |
| `AZURE_DEPLOYMENT_NAME` | `gpt-5.6-sol` | Deployment used when `CHAT_MODELS` is not set. |
| `CHAT_MODELS` | — | JSON list for the model picker: `[{"id":"<deployment>","label":"GPT-5.6","contextWindow":400000}]`. |
| `CHAT_DEFAULT_MODEL` | first model | Deployment picked by default. |
| `CHAT_CONTEXT_WINDOW` | 272000 | Context window of `AZURE_DEPLOYMENT_NAME`, for the usage ring. |
| `CHAT_MAX_STEPS` | 12 | Ceiling on tool-calling steps in one answer. |
| `CHAT_APPROVAL_SECRET` | random per process | Signs approval requests so a client can't forge an approval. Set it so pending approvals survive an API restart. |

Chat sends the text of your stories, memory and project details to the configured Azure OpenAI deployment. To add or change an assistant, see [apps/api/src/chat/agents/README.md](apps/api/src/chat/agents/README.md).

### Other commands

```sh
npm run build       # build the extension
npm test            # extension tests (VS Code host)
npm test -w @sdlc/api  # API unit tests (repository URL parsing, .gitignore rules, git parsers, catalog import, chat)
npm run test:orchestrator   # orchestrator tests (engine, catalog, run lifecycle — needs the dev database)
npm run check:orchestrator  # orchestrator lint, format and type checks
npm run start:orchestrator  # orchestrator without auto-reload
npm run package     # build the VSIX into apps/extension/
npm run db:psql     # SQL shell on the local database
npm run db:down     # stop Postgres (data is kept in a Docker volume)
```

## Docs

- [Usage](USAGE.md), [installation](INSTALL.md) and [deployment](DEPLOYMENT.md) of the extension
- [Architecture decision records](docs/adr/)
- [SDLC workflow orchestration roadmap](SDLC_WORKFLOW_ORCHESTRATION.md) and [build vs buy](BUILD_VS_BUY.md)
