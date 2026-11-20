#!/usr/bin/env bun
/**
 * Link commits and pull requests to the Development section of an Azure DevOps work item.
 * Usage:
 *   bun run .claude/scripts/devops/link-development.ts --id 1234 --commit abc123def
 *   bun run .claude/scripts/devops/link-development.ts --id 1234 --pr 2526
 *   bun run .claude/scripts/devops/link-development.ts --id 1234 --commit abc123,def456 --pr 2526
 *
 * Links appear in the "Development" section of the work item, not in comments.
 */
import { parseArgs } from "util";
import { devopsFetch, devopsJsonPatch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    id: { type: "string" },
    commit: { type: "string" },
    pr: { type: "string" },
    repo: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.id) {
  console.error(JSON.stringify({ error: "Missing required --id parameter (work item ID)" }));
  process.exit(1);
}

if (!values.commit && !values.pr) {
  console.error(JSON.stringify({ error: "Provide at least one of --commit or --pr" }));
  process.exit(1);
}

// Load config defaults
const configPath = resolve(import.meta.dir, "../../config/projects.json");
const config = (() => {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { projects: [{ name: "Synergech Product Hub", defaultRepo: "synfra" }] };
  }
})();

const project = config.projects[0];
const projectName = values.project ?? project?.name ?? "Synergech Product Hub";
const repoName = values.repo ?? project?.defaultRepo ?? "synfra";
const encodedProject = encodeURIComponent(projectName);

// Fetch project GUID and repo GUID (needed for vstfs:/// artifact URLs)
const projectInfo = await devopsFetch(`/_apis/projects/${encodedProject}`);
const projectId: string = projectInfo.id;

const repoInfo = await devopsFetch(`/${encodedProject}/_apis/git/repositories/${repoName}`);
const repoId: string = repoInfo.id;

const operations: Array<{ op: string; path: string; value: { rel: string; url: string; attributes: { name: string } } }> = [];

// Add commit links
if (values.commit) {
  for (const sha of values.commit.split(",")) {
    const commitSha = sha.trim();
    if (!commitSha) continue;

    // Resolve short SHA to full SHA via git
    const result = Bun.spawnSync(["git", "rev-parse", commitSha]);
    const fullSha = result.stdout.toString().trim() || commitSha;

    operations.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "ArtifactLink",
        url: `vstfs:///Git/Commit/${projectId}/${repoId}/${fullSha}`,
        attributes: { name: "Fixed in Commit" },
      },
    });
  }
}

// Add PR links
if (values.pr) {
  for (const prId of values.pr.split(",")) {
    const id = prId.trim();
    if (!id) continue;

    operations.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "ArtifactLink",
        url: `vstfs:///Git/PullRequestId/${projectId}/${id}`,
        attributes: { name: "Pull Request" },
      },
    });
  }
}

if (operations.length === 0) {
  console.error(JSON.stringify({ error: "No valid commits or PRs to link" }));
  process.exit(1);
}

try {
  const result = await devopsJsonPatch(
    `/${encodedProject}/_apis/wit/workitems/${values.id}`,
    operations
  );

  const linked = {
    commits: values.commit ? values.commit.split(",").map(s => s.trim()).filter(Boolean) : [],
    pullRequests: values.pr ? values.pr.split(",").map(s => s.trim()).filter(Boolean) : [],
  };

  console.log(
    JSON.stringify(
      {
        success: true,
        workItemId: result.id,
        linkedCommits: linked.commits.length,
        linkedPRs: linked.pullRequests.length,
        commits: linked.commits,
        pullRequests: linked.pullRequests,
        link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${result.id}`,
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
