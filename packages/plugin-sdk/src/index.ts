export type ToolExecutionContext = {
  actor: string;
  approvalId?: number;
  jobId?: number;
  jobRunId?: number;
};

export type ToolHandler<Input = Record<string, unknown>, Output = Record<string, unknown>> = {
  name: string;
  version: string;
  risk: "low" | "medium" | "high";
  capabilities: string[];
  run: (input: Input, ctx: ToolExecutionContext) => Promise<Output>;
};

export type PluginManifest = {
  name: string;
  version: string;
  permissions?: string[];
  tools?: string[];
};

export type PluginDefinition = {
  manifest: PluginManifest;
  tools: ToolHandler[];
};
