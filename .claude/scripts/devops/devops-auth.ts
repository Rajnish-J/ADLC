import { config } from "dotenv";
import { resolve } from "path";

// Load .env from project root
config({ path: resolve(import.meta.dir, "../../../.env") });

const pat = process.env.AZURE_DEVOPS_PAT;
const org = process.env.AZURE_DEVOPS_ORG || "synergech";

if (!pat) {
  console.error(JSON.stringify({ error: "AZURE_DEVOPS_PAT not set in .env" }));
  process.exit(1);
}

const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

export const DEVOPS_ORG = org;
export const DEVOPS_BASE_URL = `https://dev.azure.com/${org}`;

function buildUrl(path: string): string {
  const needsApiVersion = !path.includes("api-version=");
  const suffix = needsApiVersion ? `${path.includes("?") ? "&" : "?"}api-version=7.1` : "";
  return `${DEVOPS_BASE_URL}${path}${suffix}`;
}

export async function devopsFetch(path: string): Promise<any> {
  const res = await fetch(buildUrl(path), {
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DevOps API ${res.status}: ${text}`);
  }

  return res.json();
}

export async function devopsPost(path: string, body: any): Promise<any> {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DevOps API ${res.status}: ${text}`);
  }

  return res.json();
}

export async function devopsJsonPatch(path: string, operations: any[]): Promise<any> {
  const res = await fetch(buildUrl(path), {
    method: "PATCH",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json-patch+json",
    },
    body: JSON.stringify(operations),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DevOps API ${res.status}: ${text}`);
  }

  return res.json();
}

export async function devopsUploadBinary(path: string, fileBuffer: Buffer | ArrayBuffer): Promise<any> {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/octet-stream",
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DevOps API ${res.status}: ${text}`);
  }

  return res.json();
}
