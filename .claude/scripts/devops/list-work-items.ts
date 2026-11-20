#!/usr/bin/env bun
/**
 * List work items with filters.
 * Usage: bun run scripts/devops/list-work-items.ts --assigned-to "Rangaraj" --state "Active" --type "User Story"
 */
import { parseArgs } from "util";
import { devopsFetch, devopsPost } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "assigned-to": { type: "string" },
    state: { type: "string" },
    type: { type: "string" },
    project: { type: "string" },
    top: { type: "string", default: "50" },
  },
});

const projectName = values.project ?? (() => {
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.projects[0]?.name ?? "Synergech Product Hub";
})();

const encodedProject = encodeURIComponent(projectName);
const conditions: string[] = [`[System.TeamProject] = '${projectName}'`];

if (values["assigned-to"]) {
  conditions.push(`[System.AssignedTo] CONTAINS '${values["assigned-to"]}'`);
}
if (values.state) {
  conditions.push(`[System.State] = '${values.state}'`);
}
if (values.type) {
  conditions.push(`[System.WorkItemType] = '${values.type}'`);
}

const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.ChangedDate] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;

try {
  const queryResult = await devopsPost(`/${encodedProject}/_apis/wit/wiql?$top=${values.top}`, { query: wiql });
  const workItemIds: number[] = queryResult.workItems?.map((wi: any) => wi.id) || [];

  if (workItemIds.length === 0) {
    console.log(JSON.stringify({ workItems: [], count: 0 }));
    process.exit(0);
  }

  const batch = workItemIds.slice(0, 200);
  const ids = batch.join(",");
  const details = await devopsFetch(
    `/${encodedProject}/_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.ChangedDate`
  );

  const formatted = (details.value || []).map((wi: any) => ({
    id: wi.id,
    type: wi.fields["System.WorkItemType"],
    title: wi.fields["System.Title"],
    state: wi.fields["System.State"],
    assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
    changedDate: wi.fields["System.ChangedDate"],
    link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${wi.id}`,
  }));

  console.log(JSON.stringify({ workItems: formatted, count: formatted.length }, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
