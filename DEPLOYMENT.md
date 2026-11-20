# Deployment Runbook — SDLC Governance extension

How to deploy this extension as an artifact to the private Azure DevOps feed
(`sdlc-extensions`) and install it in VS Code across the org.

> A package only lands in the feed when the **Publish** stage of
> [`azure-pipelines.yml`](azure-pipelines.yml) runs, and that stage runs **only on `main` or a
> `v*` tag**. So "deploy" = get the pipeline onto `main` (or push a `v*` tag), wire up the ADO
> permissions/environment, let it run, then install from the feed.

- **Path 1** — full deployment to the feed (org-wide, recommended).
- **Path 2** — 2-minute local install today, no publish (quick test).

---

## Path 1 — Full deployment to the feed

### Step 1 — Get the pipeline onto `main` ✅ (commit/push done)
- [x] `azure-pipelines.yml` committed on `feat/workflow` and pushed.
- [ ] Merge `feat/workflow → main` (or open a CI-only PR with just the pipeline commit).
      The Publish stage will not run until the YAML is on `main`.

### Step 2 — ADO UI: register the pipeline *(skip if already registered)*
- [ ] Azure DevOps → **Pipelines** → **New pipeline** → **Azure Repos Git** → `SDLC-extension-tool`
      → **Existing Azure Pipelines YAML file** → branch `main`, path `/azure-pipelines.yml` → **Save**.

### Step 3 — ADO UI: grant the build service write access to the feed
> Without this the publish step fails with **403**.
- [ ] **Artifacts** → feed **`sdlc-extensions`** → **⚙ Settings** → **Permissions** → **Add user/group**.
- [ ] Add **`Synergech Product Hub Build Service (synergech)`** as **Contributor**
      (add whichever identity your agent actually runs as).

### Step 4 — ADO UI: let org members read the feed *(for install)*
- [ ] Same **Permissions** page → add your org/team group
      (e.g. **`[Synergech Product Hub]\Project Valid Users`**) as **Reader**.

### Step 5 — ADO UI: create the approval Environment
> The Publish stage is a `deployment` job targeting this environment.
- [ ] **Pipelines** → **Environments** → **New environment** → name exactly **`sdlc-extensions-feed`**
      → Resource: **None** → **Create**.
- [ ] Open it → **⋯** → **Approvals and checks** → **+** → **Approvals** → add approvers → **Create**.

### Step 6 — Trigger the deployment (cut a release)
> The feed rejects re-publishing an existing version, so bump first.
```bash
npm version patch --no-git-tag-version   # 0.1.0 -> 0.1.1, edits package.json
git add package.json && git commit -m "chore(release): v0.1.1"
git tag v0.1.1
git push origin main --tags
```
- [ ] Pipeline runs: Build gate → package VSIX → **Publish waits for your approval** → approve →
      Universal Package pushed to `sdlc-extensions`.

### Step 7 — Verify it landed
- [ ] **Artifacts** → feed `sdlc-extensions` → package **`sdlc-governance-extension` v0.1.1** appears.

### Step 8 — Install in VS Code (you + each org member)
```bash
# one-time per machine
az login
az extension add --name azure-devops

# download the latest published VSIX
az artifacts universal download \
  --organization "https://dev.azure.com/synergech" \
  --project "Synergech Product Hub" \
  --scope project \
  --feed sdlc-extensions \
  --name sdlc-governance-extension \
  --version "*" \
  --path .

# install into VS Code
code --install-extension ./sdlc-governance-extension-0.1.1.vsix
```
- [ ] Reload VS Code when prompted. (Same as [INSTALL.md](INSTALL.md) Option A.)

---

## Path 2 — Install on your machine today, no publish (quick test)

Validate the extension immediately while Path 1 setup happens in parallel:
```bash
npm ci
npm run package          # produces sdlc-governance-extension-0.1.0.vsix
code --install-extension ./sdlc-governance-extension-0.1.0.vsix
```
No feed, no pipeline, no ADO setup — but installs only on your machine.

> **Alternative:** open the PR from Step 1; the PR Build uploads a `vsix` pipeline artifact you
> can download from the run ([INSTALL.md](INSTALL.md) Option B) without publishing to the feed.

---

## Org-wide rollout notes
- Share [INSTALL.md](INSTALL.md) Option A with the team — that's the supported install path.
- Each release = bump version + push to `main`/tag; members re-run the `az ... download` +
  `code --install-extension` to update.
- Runtime needs: **Azure sign-in** and (by default) **GitHub Copilot** — see [USAGE.md](USAGE.md).

## Out of scope
- Changing the publish trigger (stays `main` + `v*` tags).
- Public Marketplace publishing (this is private/UNLICENSED — internal feed only).
