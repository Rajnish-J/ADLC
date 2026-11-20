---
name: commit
description: Group all pending git changes into feature-scoped commits (2–7 files each) and push. Use when the user says "push feature-wise", "commit by feature", "push code feature-wise", or wants granular commits before a push.
---

# Feature-wise Commit Skill

You are executing a **feature-wise commit workflow**. Your job is to analyse all pending git changes, group them into logical feature-scoped commits (2–7 files each), get user approval, then execute each commit sequentially and push.

**Branch rule:** Always work on the **current branch**. Never create a new branch. Push and pull on the same branch throughout.

---

## Step 0 — Lint & Build gate (mandatory before anything else)

Run both checks first:

```bash
bun run lint
bun run build
```

**If lint errors are found:**

1. Fix the offending files
2. Re-run `bun run lint` to confirm clean before continuing

**If build / TypeScript errors are found:**

1. Fix the offending files
2. Re-run `bun run build` to confirm clean before continuing

**Do not proceed to Step 1 until both `bun run lint` and `bun run build` exit with 0 errors.** This ensures all commits in the push are clean — no trailing fix commits after feature commits.

---

## Step 1 — Sync with remote (stash → pull → apply)

Run:

```bash
git status
git diff --stat HEAD
```

Count the total number of changed/new/deleted files. **If there are any local changes (modified or untracked files), always stash before pulling:**

```bash
git stash
git pull origin <current-branch>
git stash apply
```

- If `git stash apply` reports conflicts, stop and tell the user which files conflicted. Do not proceed until resolved.
- If there are no local changes at all (clean working tree), just run `git pull origin <current-branch>` directly.
- If `git stash apply` succeeds cleanly, continue to Step 2.

---

## Step 2 — Inventory all changes

Run these two commands in parallel:

```bash
git status
git diff --stat HEAD
```

Collect every modified (`M`), new (`??`), and deleted (`D`) file. Also list any new directories (untracked).

---

## Step 3 — Group files into feature batches

Apply these grouping rules in order:

| Rule                        | Files to group together                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| New page + route            | `src/app/.../page.tsx` + its container + sub-components + barrel export update                             |
| New UI primitive            | `src/components/ui/<component>.tsx` + `src/imports/UI.imports.ts`                                          |
| Type change + consumer      | `src/types/**/*.ts` + the component/hook that directly uses the new type                                   |
| Existing component refactor | Modified components that share the same feature area (e.g. all analytics components)                       |
| Minor layout/style cleanup  | Small diffs (≤ 20 lines changed) batched together regardless of feature                                    |
| Docs / skill updates        | `.claude/skills/**` + any `*.md` — batch with the smallest commit, or standalone if ≥ 3 files on their own |
| Hook + service pair         | `src/hooks/<f>/use<F>.ts` + `src/service/<f>.service.ts` for the same feature `f`                          |
| Sidebar/nav change          | Pair with the feature commit that introduced the new route                                                 |

**Constraints:**

- Minimum 2 files per commit (never a solo file unless it is truly standalone and nothing pairs with it)
- Maximum 7 files per commit — if a feature has more, split by sub-area (e.g. "types + service" vs "components")
- Each commit must be independently deployable — do not mix unrelated features

---

## Step 4 — Present the plan

Output a markdown table to the user:

```
| # | Commit message | Files | Count |
|---|----------------|-------|-------|
| 1 | feat(ui): ... | file1, file2 | 2 |
| 2 | feat(auth): ... | file1 … file6 | 6 |
...
```

Then ask: **"Does this commit plan look good? Any changes before I start committing?"**

Wait for explicit approval before proceeding to Step 5.

---

## Step 5 — Execute commits sequentially

For each batch (in order):

1. Stage only the files in this batch:

   ```bash
   git add <file1> <file2> ...
   ```

   Use explicit file paths — never `git add .` or `git add -A`.

2. Commit using a heredoc message (Conventional Commits format):

   ```bash
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <short description>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

3. Verify the commit landed:

   ```bash
   git log --oneline -1
   ```

4. Move to the next batch only after the previous commit succeeds.

**Commit message types:**

- `feat` — new feature or component
- `refactor` — restructure without behaviour change
- `fix` — bug fix
- `chore` — tooling, config, dependency
- `docs` — documentation only
- `style` — formatting, spacing (no logic change)

---

## Step 6 — Push

After all commits are done:

```bash
git log --oneline -<N>   # verify all N commits are present
git status               # confirm clean working tree
```

Then push to the **same branch** you are on — never switch or create a new branch:

```bash
git push origin <current-branch>
```

If the branch has no upstream yet:

```bash
git push -u origin <current-branch>
```

---

## Step 7 — Final report

Output a summary:

```
✅ Pushed <N> commits to <branch>:

  <sha> feat(ui): ...
  <sha> feat(comparison): ...
  <sha> feat(competition): ...
  <sha> fix(analytics): ...
```

---

## Rules

- **Never create a new branch** — always stay on the current branch for the entire workflow
- **Always stash before pulling** when there are local changes — never pull over a dirty tree
- Never use `--no-verify` to skip hooks — fix the underlying issue if a hook fails
- Never force-push (`--force`) unless the user explicitly asks
- Never amend a commit that has already been created — create a new one
- If a pre-commit hook fails, fix the issue, re-stage the same files, and create a NEW commit
- Always use explicit file paths in `git add`, never wildcards for the whole repo
- **Always run `bun run lint` and `bun run build` first** — fix every error before creating any commits
