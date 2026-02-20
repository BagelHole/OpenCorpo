import type { ToolHandler } from "./tool-types";
import { runHttpGet, runWebSearch } from "./web-tools";

const pingHandler: ToolHandler = {
  name: "system.ping",
  version: "0.0.1",
  risk: "low",
  capabilities: ["system.ping"],
  async run(input) {
    const message = typeof input.message === "string" ? input.message : "pong";
    return { ok: true, echo: message };
  }
};

const httpGetHandler: ToolHandler = {
  name: "http.get",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["web.http"],
  async run(input) {
    return runHttpGet(input);
  }
};

const webSearchHandler: ToolHandler = {
  name: "web.search",
  version: "0.0.1",
  risk: "medium",
  capabilities: ["web.search"],
  async run(input) {
    return runWebSearch(input);
  }
};

export const coreToolHandlers: ToolHandler[] = [
  pingHandler,
  httpGetHandler,
  webSearchHandler
];
