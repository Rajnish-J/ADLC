#!/usr/bin/env bun
/**
 * Upload a file to Azure DevOps and optionally link it to a work item.
 * Usage:
 *   bun run .claude/scripts/devops/upload-attachment.ts --file ./screenshot.png --work-item 1234
 *   bun run .claude/scripts/devops/upload-attachment.ts --file ./log.txt --work-item 1234 --comment "Build log"
 *   bun run .claude/scripts/devops/upload-attachment.ts --file ./report.pdf
 */
import { parseArgs } from "util";
import { devopsUploadBinary, devopsJsonPatch } from "./devops-auth";
import { readFileSync } from "fs";
import { resolve, basename } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    file: { type: "string" },
    "work-item": { type: "string" },
    comment: { type: "string" },
    project: { type: "string" },
  },
});

if (!values.file) {
  console.error(JSON.stringify({ error: "Missing required --file parameter" }));
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
const filePath = resolve(values.file);
const fileName = basename(filePath);

try {
  // Step 1: Upload the file
  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  const encodedFileName = encodeURIComponent(fileName);
  const uploadResult = await devopsUploadBinary(
    `/_apis/wit/attachments?fileName=${encodedFileName}&uploadType=Simple`
  , Buffer.from(fileBuffer));

  const attachmentUrl = uploadResult.url;

  // Step 2: Link to work item if provided
  let linkedToWorkItem: number | null = null;
  if (values["work-item"]) {
    const operations = [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: attachmentUrl,
          attributes: { comment: values.comment || "Uploaded via CLI" },
        },
      },
    ];
    await devopsJsonPatch(
      `/${encodedProject}/_apis/wit/workitems/${values["work-item"]}`,
      operations
    );
    linkedToWorkItem = parseInt(values["work-item"]);
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        attachmentId: uploadResult.id,
        attachmentUrl,
        fileName,
        linkedToWorkItem,
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
