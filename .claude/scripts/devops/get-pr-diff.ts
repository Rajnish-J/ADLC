#!/usr/bin/env bun
/**
 * Get PR diff summary (files changed, additions, deletions).
 * Usage: bun run scripts/devops/get-pr-diff.ts --id 42 --repo synfra
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
  // Get iterations to find the latest
  const iterations = await devopsFetch(
    `/${encodedProject}/_apis/git/repositories/${repoName}/pullrequests/${values.id}/iterations`
  );

  const latestIteration = iterations.value?.length || 1;

  // Get changes for the latest iteration
  const changes = await devopsFetch(
    `/${encodedProject}/_apis/git/repositories/${repoName}/pullrequests/${values.id}/iterations/${latestIteration}/changes`
  );

  const fileChanges = (changes.changeEntries || []).map((entry: any) => ({
    path: entry.item?.path || "unknown",
    changeType: entry.changeType, // edit, add, delete, rename
  }));

  const summary = {
    prId: parseInt(values.id!, 10),
    totalFilesChanged: fileChanges.length,
    additions: fileChanges.filter((f: any) => f.changeType === "add").length,
    edits: fileChanges.filter((f: any) => f.changeType === "edit").length,
    deletions: fileChanges.filter((f: any) => f.changeType === "delete").length,
    renames: fileChanges.filter((f: any) => f.changeType === "rename").length,
    files: fileChanges,
  };

  console.log(JSON.stringify(summary, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
