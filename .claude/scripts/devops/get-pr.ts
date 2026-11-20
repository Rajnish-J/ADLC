#!/usr/bin/env bun
/**
 * Get a single pull request with full details.
 * Usage: bun run scripts/devops/get-pr.ts --id 42 --repo synfra
 */
import { parseArgs } from "util";
import { devopsFetch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    id: { type: "string" },
    repo: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.id) {
  console.error(JSON.stringify({ error: "Missing required --id parameter" }));
  process.exit(1);
}

const { projectName, repoName } = (() => {
  if (values.project && values.repo) return { projectName: values.project, repoName: values.repo };
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return {
    projectName: values.project ?? config.projects[0]?.name ?? "Synergech Product Hub",
    repoName: values.repo ?? config.projects[0]?.repositories[0] ?? "synfra",
  };
})();

const encodedProject = encodeURIComponent(projectName);

try {
  const pr = await devopsFetch(`/${encodedProject}/_apis/git/repositories/${repoName}/pullrequests/${values.id}`);

  const voteLabels: Record<number, string> = {
    10: "Approved",
    5: "Approved with suggestions",
    0: "No vote",
    "-5": "Waiting for author",
    "-10": "Rejected",
  };

  const result = {
    id: pr.pullRequestId,
    title: pr.title,
    description: pr.description || "",
    status: pr.status,
    createdBy: pr.createdBy?.displayName || "Unknown",
    createdDate: pr.creationDate,
    closedDate: pr.closedDate || null,
    sourceBranch: pr.sourceRefName?.replace("refs/heads/", ""),
    targetBranch: pr.targetRefName?.replace("refs/heads/", ""),
    mergeStatus: pr.mergeStatus,
    reviewers: (pr.reviewers || []).map((r: any) => ({
      name: r.displayName,
      vote: voteLabels[r.vote] || `Unknown (${r.vote})`,
      isRequired: r.isRequired || false,
    })),
    link: `https://dev.azure.com/synergech/${encodedProject}/_git/${repoName}/pullrequest/${pr.pullRequestId}`,
  };

  console.log(JSON.stringify(result, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
