import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { configRoot } from "./paths";

export type ControlPlaneFile = {
  path: string;
  kind: string;
  valid: boolean;
  errors: string[];
};

const ajv = new Ajv2020({ allErrors: true, strict: false });

const schemaByKind = {
  policy: resolve(configRoot, "schemas/policy.schema.json"),
  tools: resolve(configRoot, "schemas/tool.schema.json"),
  jobs: resolve(configRoot, "schemas/job.schema.json"),
  workflows: resolve(configRoot, "schemas/workflow.schema.json"),
  ui: resolve(configRoot, "schemas/ui.schema.json")
} as const;

type Kind = keyof typeof schemaByKind;

function loadSchema(path: string) {
  const schema = JSON.parse(readFileSync(path, "utf-8"));
  return ajv.compile(schema);
}

const validators: Record<Kind, ReturnType<typeof loadSchema>> = {
  policy: loadSchema(schemaByKind.policy),
  tools: loadSchema(schemaByKind.tools),
  jobs: loadSchema(schemaByKind.jobs),
  workflows: loadSchema(schemaByKind.workflows),
  ui: loadSchema(schemaByKind.ui)
};

export function validateControlPlane(root: string): ControlPlaneFile[] {
  const files: ControlPlaneFile[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".json")) {
        const relative = full.replace(root + "/", "");
        const kind = detectKind(relative);
        if (!kind) {
          files.push({ path: relative, kind: "unknown", valid: true, errors: [] });
          continue;
        }
        const content = JSON.parse(readFileSync(full, "utf-8"));
        const { valid, errors } = validateControlPlaneDocument(kind, content);
        files.push({ path: relative, kind, valid, errors });
      }
    }
  }

  try {
    walk(root);
  } catch {
    return [];
  }

  return files;
}

export function detectKind(relativePath: string): Kind | null {
  if (relativePath === "policy.json") return "policy";
  const [top] = relativePath.split("/");
  if (top === "tools") return "tools";
  if (top === "jobs") return "jobs";
  if (top === "workflows") return "workflows";
  if (top === "ui") return "ui";
  return null;
}

export function validateControlPlaneDocument(kind: Kind, content: unknown) {
  const validate = validators[kind];
  const valid = validate(content) as boolean;
  const errors = valid
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`.trim());
  return { valid, errors };
}
