import type { ToolHandler } from "../../packages/plugin-sdk/src/index";
import { runHttpGet, runWebSearch } from "../../apps/daemon/src/web-tools";

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

const httpGet: ToolHandler = {
  name: "http.get",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["web.http"],
  async run(input) {
    return runHttpGet(input);
  }
};

const webSearch: ToolHandler = {
  name: "web.search",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["web.search"],
  async run(input) {
    return runWebSearch(input);
  }
};

export default function createPlugin() {
  return {
    manifest: {
      name: "core",
      version: "0.0.2",
      permissions: ["system.ping", "web.http", "web.search"],
      tools: ["system.ping", "http.get", "web.search"]
    },
    tools: [ping, httpGet, webSearch]
  };
}
