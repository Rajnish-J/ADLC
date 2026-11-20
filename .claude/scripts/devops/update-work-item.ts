#!/usr/bin/env bun
/**
 * Update an existing work item in Azure DevOps.
 * Usage:
 *   bun run scripts/devops/update-work-item.ts --id 1234 --state "Active"
 *   bun run scripts/devops/update-work-item.ts --id 1234 --title "New title" --assigned-to "Shiyam" --priority 2
 *   bun run scripts/devops/update-work-item.ts --id 1234 --state "Closed" --tags "done,sprint-12"
 *   bun run scripts/devops/update-work-item.ts --id 1234 --state "Closed" --completed-work 4 --remaining-work 0
 *
 * Any combination of fields can be updated in a single call.
 */
import { parseArgs } from "util";
import { devopsJsonPatch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    id: { type: "string" },
    title: { type: "string" },
    state: { type: "string" },
    description: { type: "string" },
    "assigned-to": { type: "string" },
    priority: { type: "string" },
    "story-points": { type: "string" },
    tags: { type: "string" },
    "acceptance-criteria": { type: "string" },
    "area-path": { type: "string" },
    "iteration-path": { type: "string" },
    "original-estimate": { type: "string" },
    "remaining-work": { type: "string" },
    "completed-work": { type: "string" },
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

const operations: any[] = [];

if (values.title) {
  operations.push({ op: "replace", path: "/fields/System.Title", value: values.title });
}

if (values.state) {
  operations.push({ op: "replace", path: "/fields/System.State", value: values.state });
}

if (values.description) {
  operations.push({ op: "replace", path: "/fields/System.Description", value: values.description });
}

if (values["assigned-to"]) {
  operations.push({ op: "replace", path: "/fields/System.AssignedTo", value: values["assigned-to"] });
}

if (values.priority) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.Priority", value: parseInt(values.priority) });
}

if (values["story-points"]) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: parseFloat(values["story-points"]) });
}

if (values.tags) {
  operations.push({ op: "replace", path: "/fields/System.Tags", value: values.tags });
}

if (values["acceptance-criteria"]) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: values["acceptance-criteria"] });
}

if (values["area-path"]) {
  operations.push({ op: "replace", path: "/fields/System.AreaPath", value: values["area-path"] });
}

if (values["iteration-path"]) {
  operations.push({ op: "replace", path: "/fields/System.IterationPath", value: values["iteration-path"] });
}

if (values["original-estimate"]) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: parseFloat(values["original-estimate"]) });
}

if (values["remaining-work"]) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: parseFloat(values["remaining-work"]) });
}

if (values["completed-work"]) {
  operations.push({ op: "replace", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: parseFloat(values["completed-work"]) });
}

if (operations.length === 0) {
  console.error(JSON.stringify({ error: "No fields to update. Provide at least one field flag." }));
  process.exit(1);
}

try {
  const result = await devopsJsonPatch(`/${encodedProject}/_apis/wit/workitems/${values.id}`, operations);

  console.log(
    JSON.stringify(
      {
        success: true,
        id: result.id,
        rev: result.rev,
        type: result.fields["System.WorkItemType"],
        title: result.fields["System.Title"],
        state: result.fields["System.State"],
        assignedTo: result.fields["System.AssignedTo"]?.displayName || "Unassigned",
        link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${result.id}`,
      },
      null,
      2
    )
  );
} catch (err: any) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
}
