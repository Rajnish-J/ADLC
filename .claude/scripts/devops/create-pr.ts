#!/usr/bin/env bun
/**
 * Create a pull request in Azure DevOps.
 * Usage:
 *   bun run .claude/scripts/devops/create-pr.ts --title "Add login" --description "Implements login flow" --source-branch feature/login --target-branch Develop --reviewers "user@example.com" --work-items "1234"
 *   bun run .claude/scripts/devops/create-pr.ts --title "Fix CSS" --description "Fixes layout" --work-items "5678" --draft
 *
 * --source-branch auto-detects from git if not provided.
 * --target-branch defaults to Develop (from config/projects.json).
 * Suraj is always added as a required reviewer.
 */
import { parseArgs } from "util";
import { devopsPost } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    title: { type: "string" },
    description: { type: "string" },
    "source-branch": { type: "string" },
    "target-branch": { type: "string" },
    reviewers: { type: "string" },
    "work-items": { type: "string" },
    draft: { type: "boolean", default: false },
    repo: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.title) {
  console.error(JSON.stringify({ error: "Missing required --title parameter" }));
  process.exit(1);
}

if (!values.description) {
  console.error(JSON.stringify({ error: "Missing required --description parameter" }));
  process.exit(1);
}

if (!values["work-items"]) {
  console.error(JSON.stringify({ error: "Missing required --work-items parameter" }));
  process.exit(1);
}

// Load config defaults
const configPath = resolve(import.meta.dir, "../../config/projects.json");
const config = (() => {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { projects: [{ name: "Synergech Product Hub", repositories: ["synfra"], defaultRepo: "synfra", defaultBranch: "Develop", team: [] }] };
  }
})();

const project = config.projects[0];
const projectName = values.project ?? project?.name ?? "Synergech Product Hub";
const repoName = values.repo ?? project?.defaultRepo ?? "synfra";
const defaultBranch = project?.defaultBranch ?? "Develop";
const encodedProject = encodeURIComponent(projectName);

// Resolve source branch
const sourceBranch = values["source-branch"] ?? (() => {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = result.stdout.toString().trim();
  if (!branch || branch === "HEAD") {
    console.error(JSON.stringify({ error: "Could not detect current branch. Provide --source-branch." }));
    process.exit(1);
  }
  return branch;
})();

const targetBranch = values["target-branch"] ?? defaultBranch;

// Map short names to Azure DevOps identity GUIDs
const identityMap: Record<string, string> = {
  suraj: "b11b3b69-9775-6d53-84b6-56dc97eb1a00",
  rengaraj: "b2f365e8-8ac9-632a-b18b-a6a572cbdc54",
  vibheesh: "ec6cc0c0-9d12-69c5-b3bd-5d687bc864e2",
  shiyam: "1a1b69ad-f57e-66ca-a69b-2ae2fd8613d5",
  rajnish: "133756d3-9637-6fce-8e18-e999496f446e",
};

function resolveIdentity(name: string): string {
  return identityMap[name.toLowerCase()] ?? name;
}

// Build reviewers list — Suraj is always required
const reviewersList: Array<{ id: string; isRequired: boolean }> = [
  { id: resolveIdentity("Suraj"), isRequired: true },
];

if (values.reviewers) {
  for (const r of values.reviewers.split(",")) {
    const name = r.trim();
    if (name.toLowerCase() !== "suraj") {
      reviewersList.push({ id: resolveIdentity(name), isRequired: false });
    }
  }
}

// Build work item refs
const workItemRefs = values["work-items"]!
  .split(",")
  .map((id) => ({ id: id.trim() }));

const prBody = {
  sourceRefName: `refs/heads/${sourceBranch}`,
  targetRefName: `refs/heads/${targetBranch}`,
  title: values.title,
  description: values.description,
  isDraft: values.draft ?? false,
  reviewers: reviewersList,
  workItemRefs,
};

try {
  const result = await devopsPost(
    `/${encodedProject}/_apis/git/repositories/${repoName}/pullrequests`,
    prBody
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        id: result.pullRequestId,
        title: result.title,
        status: result.status,
        sourceBranch: result.sourceRefName?.replace("refs/heads/", ""),
        targetBranch: result.targetRefName?.replace("refs/heads/", ""),
        createdBy: result.createdBy?.displayName || "Unknown",
        isDraft: result.isDraft,
        reviewers: (result.reviewers || []).map((r: { displayName: string; isRequired: boolean }) => ({
          name: r.displayName,
          isRequired: r.isRequired,
        })),
        workItemsLinked: workItemRefs.length,
        link: `https://dev.azure.com/synergech/${encodedProject}/_git/${repoName}/pullrequest/${result.pullRequestId}`,
      },
      null,
      2
    )
  );
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
