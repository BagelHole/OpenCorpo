import type { ToolHandler } from "../../packages/plugin-sdk/src/index";

const ping: ToolHandler = {
  name: "system.ping",
  version: "0.0.1",
  risk: "low",
  capabilities: ["system.ping"],
  async run(input) {
    const message = typeof input.message === "string" ? input.message : "pong";
    return { ok: true, echo: message };
  }
};

export default function createPlugin() {
  return {
    manifest: {
      name: "core",
      version: "0.0.1",
      permissions: ["system.ping"],
      tools: ["system.ping"]
    },
    tools: [ping]
  };
}
