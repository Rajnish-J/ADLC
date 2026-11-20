#!/usr/bin/env bun
/**
 * Get work items created or updated in the last N days.
 * Usage: bun run scripts/devops/recent-changes.ts --days 1 --project "Synergech Product Hub"
 */
import { parseArgs } from "util";
import { devopsFetch, devopsPost } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    days: { type: "string", default: "1" },
    project: { type: "string" },
  },
});

// Load project config if no project specified
const projectName = values.project ?? (() => {
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.projects[0]?.name ?? "Synergech Product Hub";
})();

const days = parseInt(values.days || "1", 10);
const encodedProject = encodeURIComponent(projectName);

const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.ChangedDate], [System.CreatedDate], [System.ChangedBy] FROM WorkItems WHERE [System.TeamProject] = '${projectName}' AND [System.ChangedDate] > @Today-${days} ORDER BY [System.ChangedDate] DESC`;

try {
  // Query work item IDs
  const queryResult = await devopsPost(`/${encodedProject}/_apis/wit/wiql`, { query: wiql });
  const workItemIds: number[] = queryResult.workItems?.map((wi: any) => wi.id) || [];

  if (workItemIds.length === 0) {
    console.log(JSON.stringify({ workItems: [], count: 0, message: `No work items changed in the last ${days} day(s)` }));
    process.exit(0);
  }

  // Fetch full details in batches of 200
  const allWorkItems: any[] = [];
  for (let i = 0; i < workItemIds.length; i += 200) {
    const batch = workItemIds.slice(i, i + 200);
    const ids = batch.join(",");
    const details = await devopsFetch(
      `/${encodedProject}/_apis/wit/workitems?ids=${ids}&$expand=None&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.ChangedDate,System.CreatedDate,System.ChangedBy`
    );
    allWorkItems.push(...(details.value || []));
  }

  // Format output
  const formatted = allWorkItems.map((wi: any) => {
    const fields = wi.fields;
    const createdDate = new Date(fields["System.CreatedDate"]);
    const changedDate = new Date(fields["System.ChangedDate"]);
    const isNew = (Date.now() - createdDate.getTime()) < days * 24 * 60 * 60 * 1000;

    return {
      id: wi.id,
      type: fields["System.WorkItemType"],
      title: fields["System.Title"],
      state: fields["System.State"],
      assignedTo: fields["System.AssignedTo"]?.displayName || "Unassigned",
      changedBy: fields["System.ChangedBy"]?.displayName || "Unknown",
      changedDate: fields["System.ChangedDate"],
      change: isNew ? "NEW" : "UPDATED",
      link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${wi.id}`,
    };
  });

  console.log(JSON.stringify({ workItems: formatted, count: formatted.length }, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
