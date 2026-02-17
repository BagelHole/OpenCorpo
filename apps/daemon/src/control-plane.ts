import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative as pathRelative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { schemaRoot } from "./paths";

export type ControlPlaneFile = {
  path: string;
  kind: string;
  valid: boolean;
  errors: string[];
};

const ajv = new Ajv2020({ allErrors: true, strict: false });

const schemaByKind = {
  policy: resolve(schemaRoot, "policy.schema.json"),
  tools: resolve(schemaRoot, "tool.schema.json"),
  jobs: resolve(schemaRoot, "job.schema.json"),
  workflows: resolve(schemaRoot, "workflow.schema.json"),
  ui: resolve(schemaRoot, "ui.schema.json")
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
        const relative = pathRelative(root, full).replaceAll("\\", "/");
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
  const schemaErrors = valid
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`.trim());
  const customErrors =
    kind === "jobs" ? validateJobDocument(content) : kind === "ui" ? validateUiDocument(content) : [];
  const errors = [...schemaErrors, ...customErrors];
  return { valid: errors.length === 0, errors };
}

function validateJobDocument(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const job = content as Record<string, unknown>;
  const errors: string[] = [];

  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object") continue;
    const toolRaw = (step as Record<string, unknown>).tool;
    const tool = typeof toolRaw === "string" ? normalizeToolName(toolRaw) : "";
    if (tool === "script.run") {
      errors.push(`/steps/${index}/tool script.run is not supported. Use top-level script.path jobs.`);
    }
  }

  const type = typeof job.type === "string" ? job.type.trim().toLowerCase() : "";
  const script = job.script && typeof job.script === "object" ? (job.script as Record<string, unknown>) : null;
  if (type === "script") {
    if (!script) {
      errors.push(`/script is required when type is "script".`);
    } else {
      const path = typeof script.path === "string" ? script.path.trim() : "";
      if (!path) {
        errors.push(`/script/path is required for script jobs.`);
      }
      if ("source" in script) {
        errors.push(`/script/source is not supported. Use /script/path pointing to userland/jobs/*.ts.`);
      }
      const dependencies = script.dependencies;
      if (dependencies !== undefined) {
        if (!Array.isArray(dependencies)) {
          errors.push(`/script/dependencies must be an array of npm package specs.`);
        } else if (dependencies.length > 20) {
          errors.push(`/script/dependencies supports at most 20 items.`);
        } else {
          for (const [index, dep] of dependencies.entries()) {
            if (typeof dep !== "string" || !isSafeScriptDependencySpec(dep)) {
              errors.push(
                `/script/dependencies/${index} must be a safe npm package spec (registry only).`
              );
            }
          }
        }
      }
    }
  }

  return errors;
}

function normalizeToolName(name: string) {
  return name.trim().toLowerCase().replace(/[_.-]+/g, ".");
}

function validateUiDocument(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const ui = content as Record<string, unknown>;
  const errors: string[] = [];
  const pages = Array.isArray(ui.pages) ? ui.pages : [];
  const sidebarItems =
    ui.sidebar && typeof ui.sidebar === "object" && Array.isArray((ui.sidebar as any).items)
      ? ((ui.sidebar as any).items as Array<Record<string, unknown>>)
      : [];

  const pageIds = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (!page || typeof page !== "object") continue;
    const id = typeof (page as Record<string, unknown>).id === "string" ? String((page as any).id).trim() : "";
    if (!id) continue;
    if (pageIds.has(id)) {
      errors.push(`/pages/${index}/id duplicate page id "${id}".`);
      continue;
    }
    pageIds.add(id);
  }

  const sidebarIds = new Set<string>();
  const sidebarPaths = new Set<string>();
  for (const [index, item] of sidebarItems.entries()) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const pageId = typeof item.pageId === "string" ? item.pageId.trim() : "";
    if (id) {
      if (sidebarIds.has(id)) errors.push(`/sidebar/items/${index}/id duplicate sidebar id "${id}".`);
      sidebarIds.add(id);
    }
    if (path) {
      if (sidebarPaths.has(path)) errors.push(`/sidebar/items/${index}/path duplicate sidebar path "${path}".`);
      sidebarPaths.add(path);
    }
    if (pageId && !pageIds.has(pageId)) {
      errors.push(
        `/sidebar/items/${index}/pageId references missing page "${pageId}". Add a page with id "${pageId}" or remove this sidebar item.`
      );
    }
  }

  return errors;
}

function isSafeScriptDependencySpec(value: string) {
  const spec = value.trim();
  if (!spec) return false;
  if (/\s/.test(spec)) return false;
  const lower = spec.toLowerCase();
  const blockedPrefixes = [
    ".",
    "/",
    "\\",
    "file:",
    "link:",
    "workspace:",
    "git+",
    "http:",
    "https:",
    "github:"
  ];
  if (blockedPrefixes.some((prefix) => lower.startsWith(prefix))) return false;
  if (spec.includes(":") || spec.includes("#")) return false;

  let name = spec;
  let version = "";
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    if (separator > 0) {
      name = spec.slice(0, separator);
      version = spec.slice(separator + 1);
    }
  } else {
    const separator = spec.indexOf("@");
    if (separator > 0) {
      name = spec.slice(0, separator);
      version = spec.slice(separator + 1);
    }
  }
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return false;
  if (!version) return true;
  return /^[a-z0-9*^~<>=|.-]+$/i.test(version);
}
