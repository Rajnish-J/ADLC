#!/usr/bin/env bun
/**
 * Get a single work item by ID with full details.
 * Usage: bun run scripts/devops/get-work-item.ts --id 1234
 */
import { parseArgs } from "util";
import { devopsFetch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    id: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.id) {
  console.error(JSON.stringify({ error: "Missing required --id parameter" }));
  process.exit(1);
}

const projectName = values.project ?? (() => {
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.projects[0]?.name ?? "Synergech Product Hub";
})();

const encodedProject = encodeURIComponent(projectName);

try {
  const wi = await devopsFetch(`/${encodedProject}/_apis/wit/workitems/${values.id}?$expand=All`);

  const result = {
    id: wi.id,
    rev: wi.rev,
    type: wi.fields["System.WorkItemType"],
    title: wi.fields["System.Title"],
    state: wi.fields["System.State"],
    assignedTo: wi.fields["System.AssignedTo"]?.displayName || "Unassigned",
    createdBy: wi.fields["System.CreatedBy"]?.displayName || "Unknown",
    createdDate: wi.fields["System.CreatedDate"],
    changedBy: wi.fields["System.ChangedBy"]?.displayName || "Unknown",
    changedDate: wi.fields["System.ChangedDate"],
    description: wi.fields["System.Description"] || "",
    acceptanceCriteria: wi.fields["Microsoft.VSTS.Common.AcceptanceCriteria"] || "",
    priority: wi.fields["Microsoft.VSTS.Common.Priority"] || null,
    storyPoints: wi.fields["Microsoft.VSTS.Scheduling.StoryPoints"] || null,
    tags: wi.fields["System.Tags"] || "",
    link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${wi.id}`,
  };

  console.log(JSON.stringify(result, null, 2));
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
