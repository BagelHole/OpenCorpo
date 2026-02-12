import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { validateControlPlane } from "./control-plane";
import { configRoot } from "./paths";

export type ControlPlaneStatus = {
  root: string;
  entries: string[];
  validation: ReturnType<typeof validateControlPlane>;
};

export function loadControlPlane(): ControlPlaneStatus {
  const root = process.env.OPENCORPO_CONFIG_DIR
    ? resolve(process.env.OPENCORPO_CONFIG_DIR)
    : configRoot;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  const validation = validateControlPlane(root);
  const invalidFiles = validation.filter((file) => !file.valid);
  const allowInvalid = process.env.OPENCORPO_ALLOW_INVALID_CONTROL_PLANE === "true";
  if (invalidFiles.length > 0 && !allowInvalid) {
    const details = invalidFiles
      .map((file) => `${file.path}: ${file.errors.join(", ") || "invalid"}`)
      .join(" | ");
    throw new Error(
      `Control Plane validation failed. Set OPENCORPO_ALLOW_INVALID_CONTROL_PLANE=true to bypass. ${details}`
    );
  }
  return { root, entries, validation };
}
