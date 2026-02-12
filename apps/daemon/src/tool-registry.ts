import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import type { ToolDefinition } from "./tools";
import type { ToolHandler } from "./tool-types";

export type ToolRegistry = {
  definitions: ToolDefinition[];
  handlers: Map<string, ToolHandler>;
  warnings: string[];
  validators: Map<string, ValidateFunction>;
};

const ajv = new Ajv2020({ allErrors: true, strict: false });

export function buildToolRegistry(
  definitions: ToolDefinition[],
  handlers: ToolHandler[]
): ToolRegistry {
  const handlerMap = new Map<string, ToolHandler>();
  const validators = new Map<string, ValidateFunction>();
  const warnings: string[] = [];

  for (const handler of handlers) {
    if (handlerMap.has(handler.name)) {
      warnings.push(`duplicate_handler:${handler.name}`);
      continue;
    }
    handlerMap.set(handler.name, handler);
  }

  const defined = new Set(definitions.map((d) => d.name));
  for (const handler of handlers) {
    if (!defined.has(handler.name)) {
      warnings.push(`handler_missing_definition:${handler.name}`);
    }
  }

  for (const def of definitions) {
    if (!def.inputs || typeof def.inputs !== "object") continue;
    try {
      const validate = ajv.compile(def.inputs as Record<string, unknown>);
      validators.set(def.name, validate);
    } catch {
      warnings.push(`invalid_input_schema:${def.name}`);
    }
  }

  return { definitions, handlers: handlerMap, warnings, validators };
}

export function getToolDefinition(
  registry: ToolRegistry,
  name: string
): ToolDefinition | null {
  return registry.definitions.find((tool) => tool.name === name) ?? null;
}

export function validateToolInput(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown> | null
) {
  const validate = registry.validators.get(name);
  if (!validate) return { valid: true, errors: [] };
  const ok = validate(input ?? {});
  if (ok) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (err) => `${err.instancePath || "/"} ${err.message ?? ""}`.trim()
  );
  return { valid: false, errors };
}

export function validateToolOutput(
  registry: ToolRegistry,
  name: string,
  output: Record<string, unknown> | null
) {
  const def = registry.definitions.find((tool) => tool.name === name);
  if (!def || !def.outputs || typeof def.outputs !== "object") {
    return { valid: true, errors: [] };
  }

  try {
    const validate = ajv.compile(def.outputs as Record<string, unknown>);
    const ok = validate(output ?? {});
    if (ok) return { valid: true, errors: [] };
    const errors = (validate.errors ?? []).map(
      (err) => `${err.instancePath || "/"} ${err.message ?? ""}`.trim()
    );
    return { valid: false, errors };
  } catch {
    return { valid: false, errors: ["invalid_output_schema"] };
  }
}
