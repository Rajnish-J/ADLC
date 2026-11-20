# Chat assistants

Each `*.md` file in [`definitions/`](definitions/) defines one assistant in the Chat picker. Both the web `/chat` page and the VS Code chat panel use them.

The API reads the files once at startup ([`loader.ts`](loader.ts)) and checks them. If a file has an unknown tool, a bad field, or a name that doesn't match the file name, the API refuses to start, rather than silently running without that tool.

## File format

```markdown
---
name: workflows            # the picker id; must match the file name (workflows.md)
label: Workflows           # shown in the picker
icon: Workflow             # a lucide icon name (the web maps it; the extension shows the label only)
description: One or two lines shown under the name in the picker.
scope: project             # project: works inside one project (the project chip is required) · org: across projects
draft: workflow            # what it builds through Review & submit: workflow | project | agent | skill | stories (omit if nothing)
placeholder: Text shown in the empty message box
order: 10                  # position in the picker (default is always first)
maxSteps: 14               # tool-calling steps per answer (capped by CHAT_MAX_STEPS)
tools:                     # tool names from ../tools (see below); "@read" = every read-only tool
  - list_workflows
  - update_draft
  - ask_user
---

# The assistant's instructions

Everything after the front matter is this assistant's system prompt.
```

## Prompt order

The engine ([`../engine.ts`](../engine.ts)) builds each turn's prompt in this order:
1. A shared preamble: the platform model and the ground rules for approvals, questions and secrets.
2. This file's body.
3. The context: date, user, the picked project and the user's role in it, and the tools the user can't use.
4. For drafting assistants: the current draft, as JSON.

## Tools

Tools live in [`../tools/`](../tools/), one file per domain. A tool can be one of four kinds:
- **Read** tools look things up. They run without asking, except in the "Ask every time" mode.
- **Write** tools (`access: 'write'`) change the platform. Each one shows the user an Approve / Reject card, enforced through `streamText({ toolApproval })`. Each write tool declares the `permission` it needs; the Tools popover hides the ones the user's role lacks, and the service checks again.
- **Draft** tools (`update_draft`, `load_*_into_draft`) only write the chat's draft. The user submits that draft through Review & submit ([`../submit.ts`](../submit.ts)), which calls the real services as the user.
- **Interaction** tools (`ask_user`, `handoff`) have no server side. The user answers them in the UI.

Every tool calls the existing services in-process as the signed-in user, so permission checks, the audit log (`via: <client>:chat`) and live events all apply.

## Adding an assistant

1. Add `definitions/<name>.md` with the front matter above.
2. If it needs a new tool, add it to a file in `../tools/` with `defineChatTool` and list it in `../tools/index.ts`.
3. If it builds a new kind of thing, also:
   - add the draft kind in `packages/contracts/src/chat.ts`: `DRAFT_KINDS`, its data schema, `DRAFT_FORMS` and `EMPTY_DRAFT_DATA`
   - add its submit handler in `../submit.ts`
4. Run `npm test -w @sdlc/api`. The tests check that every listed tool exists, that drafting assistants can draft and ask, and that Default and Portfolio stay read-only.
5. Add example prompts for the empty screen in `apps/web/src/components/chat/chatHelpers.ts` (`SUGGESTIONS`).
