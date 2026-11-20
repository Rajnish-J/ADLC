#!/usr/bin/env bun
/**
 * Add a discussion comment to an Azure DevOps work item.
 * Usage:
 *   bun run .claude/scripts/devops/add-work-item-comment.ts --id 1234 --text "Work completed, see screenshots"
 *   bun run .claude/scripts/devops/add-work-item-comment.ts --id 1234 --text "<h3>Done</h3><p>See PR #42</p>"
 *
 * The --text field supports HTML for rich formatting.
 */
import { parseArgs } from "util";
import { devopsPost } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    id: { type: "string" },
    text: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.id) {
  console.error(JSON.stringify({ error: "Missing required --id parameter" }));
  process.exit(1);
}

if (!values.text) {
  console.error(JSON.stringify({ error: "Missing required --text parameter" }));
  process.exit(1);
}

const projectName = values.project ?? (() => {
  const configPath = resolve(import.meta.dir, "../../config/projects.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.projects[0]?.name ?? "Synergech Product Hub";
  } catch {
    return "Synergech Product Hub";
  }
})();

const encodedProject = encodeURIComponent(projectName);

try {
  const result = await devopsPost(
    `/${encodedProject}/_apis/wit/workitems/${values.id}/comments?api-version=7.1-preview.4`,
    { text: values.text }
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        commentId: result.id,
        workItemId: parseInt(values.id),
        text: result.text,
        createdDate: result.createdDate,
        link: `https://dev.azure.com/synergech/${encodedProject}/_workitems/edit/${values.id}`,
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
