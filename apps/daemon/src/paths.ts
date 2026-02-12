import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const projectRoot = process.env.OPENCORPO_PROJECT_ROOT
  ? resolve(process.env.OPENCORPO_PROJECT_ROOT)
  : resolve(here, "../../..");

export const dataRoot = process.env.OPENCORPO_DATA_DIR
  ? resolve(process.env.OPENCORPO_DATA_DIR)
  : resolve(projectRoot, "data");

export const configRoot = process.env.OPENCORPO_CONFIG_DIR
  ? resolve(process.env.OPENCORPO_CONFIG_DIR)
  : resolve(projectRoot, "config");

export const pluginsRoot = process.env.OPENCORPO_PLUGINS_DIR
  ? resolve(process.env.OPENCORPO_PLUGINS_DIR)
  : resolve(projectRoot, "plugins");

export const userlandRoot = process.env.OPENCORPO_USERLAND_DIR
  ? resolve(process.env.OPENCORPO_USERLAND_DIR)
  : resolve(projectRoot, "userland");

export const workspaceRoot = resolve(userlandRoot, "workspace");
export const jobsScriptsRoot = resolve(userlandRoot, "jobs");

export const secretsRoot = process.env.OPENCORPO_SECRETS_DIR
  ? resolve(process.env.OPENCORPO_SECRETS_DIR)
  : resolve(dataRoot, "secrets");
