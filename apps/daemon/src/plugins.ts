import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolHandler } from "./tool-types";

export type PluginManifest = {
  name: string;
  version: string;
  permissions?: string[];
  tools?: string[];
  entry?: string;
};

export type PluginDefinition = {
  manifest: PluginManifest;
  tools: ToolHandler[];
};

export type PluginLoadResult = {
  manifest: PluginManifest;
  loaded: boolean;
  error?: string;
  definition?: PluginDefinition;
};

export type PluginManifestEntry = {
  manifest: PluginManifest;
  dir: string;
};

export function loadPluginManifests(pluginRoot: string): PluginManifestEntry[] {
  const root = resolve(pluginRoot);
  const manifests: PluginManifestEntry[] = [];
  try {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      const manifestPath = join(full, "manifest.json");
      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as PluginManifest;
        manifests.push({ manifest, dir: full });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return manifests;
}

export async function loadPluginDefinitions(
  pluginRoot: string
): Promise<PluginLoadResult[]> {
  const root = resolve(pluginRoot);
  const results: PluginLoadResult[] = [];
  for (const entry of loadPluginManifests(root)) {
    const entryFile = entry.manifest.entry ?? "handler.ts";
    const entryPath = join(entry.dir, entryFile);
    try {
      const moduleUrl = pathToFileURL(entryPath).toString();
      const mod = await import(moduleUrl);
      const createPlugin =
        typeof mod.default === "function"
          ? mod.default
          : typeof mod.createPlugin === "function"
          ? mod.createPlugin
          : null;
      if (!createPlugin) {
        results.push({
          manifest: entry.manifest,
          loaded: false,
          error: "Missing createPlugin() or default export"
        });
        continue;
      }
      const definition = createPlugin() as PluginDefinition;
      results.push({ manifest: entry.manifest, loaded: true, definition });
    } catch (error) {
      results.push({
        manifest: entry.manifest,
        loaded: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }
  return results;
}
