#!/usr/bin/env bun
/**
 * List pull requests for a repository.
 * Usage: bun run scripts/devops/list-prs.ts --status active --repo synfra
 */
import { parseArgs } from "util";
import { devopsFetch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    status: { type: "string", default: "active" },
    repo: { type: "string" },
    project: { type: "string" },
    "created-by": { type: "string" },
    top: { type: "string", default: "50" },
  },
});

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
  let endpoint = `/${encodedProject}/_apis/git/repositories/${repoName}/pullrequests?searchCriteria.status=${values.status}&$top=${values.top}`;
  if (values["created-by"]) {
    endpoint += `&searchCriteria.creatorId=${values["created-by"]}`;
  }

  const result = await devopsFetch(endpoint);
  const prs = (result.value || []).map((pr: any) => ({
    id: pr.pullRequestId,
    title: pr.title,
    description: (pr.description || "").substring(0, 500),
    status: pr.status,
    createdBy: pr.createdBy?.displayName || "Unknown",
    createdDate: pr.creationDate,
    sourceBranch: pr.sourceRefName?.replace("refs/heads/", ""),
    targetBranch: pr.targetRefName?.replace("refs/heads/", ""),
    reviewers: (pr.reviewers || []).map((r: any) => ({
      name: r.displayName,
      vote: r.vote, // 10=approved, 5=approved with suggestions, 0=no vote, -5=waiting, -10=rejected
    })),
    mergeStatus: pr.mergeStatus,
    link: `https://dev.azure.com/synergech/${encodedProject}/_git/${repoName}/pullrequest/${pr.pullRequestId}`,
  }));

  console.log(JSON.stringify({ pullRequests: prs, count: prs.length }, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
