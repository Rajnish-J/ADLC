#!/usr/bin/env bun
/**
 * Create a work item in Azure DevOps.
 * Usage:
 *   bun run scripts/devops/create-work-item.ts --type "User Story" --title "Implement login" --description "As a user..."
 *   bun run scripts/devops/create-work-item.ts --type "Task" --title "Fix CSS" --assigned-to "Shiyam" --parent 1234
 *   bun run scripts/devops/create-work-item.ts --type "Bug" --title "Login crash" --priority 1 --tags "prod,urgent"
 *   bun run scripts/devops/create-work-item.ts --type "Task" --title "Implement API" --original-estimate 4 --parent 1234
 *
 * Supported types: User Story, Task, Bug, Feature, Epic
 */
import { parseArgs } from "util";
import { devopsJsonPatch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    type: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    "assigned-to": { type: "string" },
    priority: { type: "string" },
    "story-points": { type: "string" },
    tags: { type: "string" },
    parent: { type: "string" },
    "acceptance-criteria": { type: "string" },
    "area-path": { type: "string" },
    "iteration-path": { type: "string" },
    "original-estimate": { type: "string" },
    "remaining-work": { type: "string" },
    "completed-work": { type: "string" },
    project: { type: "string" },
  },
});

if (!values.type || !values.title) {
  console.error(JSON.stringify({ error: "Missing required --type and --title parameters" }));
  process.exit(1);
}

const projectName = values.project ?? (() => {
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.projects[0]?.name ?? "Synergech Product Hub";
})();

const encodedProject = encodeURIComponent(projectName);
const encodedType = encodeURIComponent(values.type);

const operations: any[] = [
  { op: "add", path: "/fields/System.Title", value: values.title },
];

if (values.description) {
  operations.push({ op: "add", path: "/fields/System.Description", value: values.description });
}

if (values["assigned-to"]) {
  operations.push({ op: "add", path: "/fields/System.AssignedTo", value: values["assigned-to"] });
}

if (values.priority) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: parseInt(values.priority) });
}

if (values["story-points"]) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: parseFloat(values["story-points"]) });
}

if (values.tags) {
  operations.push({ op: "add", path: "/fields/System.Tags", value: values.tags });
}

if (values["acceptance-criteria"]) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: values["acceptance-criteria"] });
}

if (values["area-path"]) {
  operations.push({ op: "add", path: "/fields/System.AreaPath", value: values["area-path"] });
}

if (values["iteration-path"]) {
  operations.push({ op: "add", path: "/fields/System.IterationPath", value: values["iteration-path"] });
}

if (values["original-estimate"]) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: parseFloat(values["original-estimate"]) });
}

if (values["remaining-work"]) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: parseFloat(values["remaining-work"]) });
}

if (values["completed-work"]) {
  operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: parseFloat(values["completed-work"]) });
}

if (values.parent) {
  operations.push({
    op: "add",
    path: "/relations/-",
    value: {
      rel: "System.LinkTypes.Hierarchy-Reverse",
      url: `https://dev.azure.com/synergech/${encodedProject}/_apis/wit/workitems/${values.parent}`,
    },
  });
}

try {
  const result = await devopsJsonPatch(`/${encodedProject}/_apis/wit/workitems/$${encodedType}`, operations);

  console.log(
    JSON.stringify(
      {
        success: true,
        id: result.id,
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
