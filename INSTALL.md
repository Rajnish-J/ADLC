# Installing the SDLC Governance extension (internal)

This is a **private**, internal-only extension. It is not on the public VS Code
Marketplace. Builds are produced by [`azure-pipelines.yml`](azure-pipelines.yml) and
published to the private Azure DevOps Artifacts feed **`sdlc-extensions`** in the
`synergech` / *Synergech Product Hub* org.

There are two ways to install it. Both end with `code --install-extension`.

## Option A — from the Artifacts feed (recommended)

Gets you the latest published version. Requires Azure CLI with the DevOps extension
and access to the feed.

```bash
# One-time: sign in and add the azure-devops extension
az login
az extension add --name azure-devops

# Download the latest VSIX into the current directory
az artifacts universal download \
  --organization "https://dev.azure.com/synergech" \
  --project "Synergech Product Hub" \
  --scope project \
  --feed sdlc-extensions \
  --name sdlc-governance-extension \
  --version "*" \
  --path .

# Install it into VS Code
code --install-extension ./sdlc-governance-extension-*.vsix
```

> To install a specific release, replace `--version "*"` with the exact version,
> e.g. `--version 0.1.0`.

## Option B — from a pipeline build artifact

No feed access needed — just access to the pipeline run.

1. Open the pipeline run in Azure DevOps → **Artifacts** → download the **`vsix`** artifact.
2. Unzip it to get `sdlc-governance-extension-<version>.vsix`.
3. In VS Code: **Extensions** view → `…` menu → **Install from VSIX…** → pick the file.
   (Or run `code --install-extension <path>.vsix`.)

## Updating

Re-run Option A (or B) with the newer version and install over the top — VS Code
replaces the existing build. Reload the window when prompted.

## Claude Code and Codex come with it

The extension is an **extension pack** for two coding harnesses: **Claude Code** (`anthropic.claude-code`) and
**Codex** (`openai.chatgpt`). Installing the extension, from the feed or from a VSIX, also installs both from the
Visual Studio Marketplace.
- **Sign in to each harness** before starting a run in it. Installing only makes it available.
- **If one is missing later**, for example after it was uninstalled or the install ran offline, the extension
  installs it again a few seconds after it starts, once per extension version.
  - **To manage them yourself:** turn this off with `sdlcGovernance.harnesses.autoInstall`. Uninstalling either
    one never disables this extension.
  - **To install them on demand:** run **SDLC Governance: Install Claude Code and Codex**.
- **Offline or locked-down machines** have no Marketplace access. Install the two harnesses' VSIX files next to
  this one, or ask IT to allow `anthropic.claude-code`, `openai.chatgpt` and `openai.codex-audio` (a Codex
  dependency).

## Runtime prerequisites

The extension installs without these, but features need them at runtime (see
[USAGE.md](USAGE.md) for detail):

- **Azure sign-in** — to list Foundry projects and run evaluation gates
  (*SDLC Governance: Sign in to Azure*).
- **GitHub Copilot** — required when `sdlcGovernance.dispatch.mode` is `lm` (the default),
  since workflow agents run via the VS Code Language Model API. Set it to `mock` for
  offline/no-Copilot use.
- **Platform sign-in and Azure OpenAI on the API** — for *SDLC Platform: Open Chat*, the
  chat panel with the platform's specialist assistants (see the Chat section of [README.md](README.md)).

## For maintainers — cutting a release

The feed rejects re-publishing an existing version, so every release needs a bump:

1. Bump `version` in [package.json](package.json) (e.g. `npm version patch --no-git-tag-version`).
2. Commit, then tag `vX.Y.Z` and push the tag (or merge to `main`).
3. The pipeline runs the gate, packages the VSIX, and publishes it to `sdlc-extensions`.
