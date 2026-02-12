import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type ToolDefinition = {
  name: string;
  version: string;
  risk: "low" | "medium" | "high";
  capabilities: string[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

export function loadToolsConfig(configRoot: string): ToolDefinition[] {
  const toolsDir = resolve(configRoot, "tools");
  const tools: ToolDefinition[] = [];
  try {
    for (const entry of readdirSync(toolsDir)) {
      const full = join(toolsDir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        for (const file of readdirSync(full)) {
          if (!file.endsWith(".json")) continue;
          const tool = JSON.parse(readFileSync(join(full, file), "utf-8"));
          tools.push(tool as ToolDefinition);
        }
      } else if (entry.endsWith(".json")) {
        const tool = JSON.parse(readFileSync(full, "utf-8"));
        tools.push(tool as ToolDefinition);
      }
    }
  } catch {
    return [];
  }
  return tools;
}

export function findTool(
  tools: ToolDefinition[],
  name: string
): ToolDefinition | null {
  return tools.find((tool) => tool.name === name) ?? null;
}
