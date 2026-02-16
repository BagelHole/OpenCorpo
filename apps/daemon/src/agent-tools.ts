import { tool } from "ai";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentContext } from "./agent";
import {
  buildApprovalsList,
  buildAuditList,
  buildDataSourceHint,
  buildHelpText,
  buildJobRunsList,
  buildJobsList,
  buildPluginsList,
  buildStatusSummary,
  buildToolsList,
  handleApprovalAction,
  handleApprovalDetail,
  handleAuditDetail,
  handleJobDetail,
  handleJobRun,
  handleJobRunByName,
  handleJobRunDetail,
  handleJobToggle,
  handleToolDetail,
  handleToolRunDetail
} from "./agent";
import { createApproval } from "./approvals";
import { writeAudit } from "./audit";
import { attachCodeChangeApproval, proposeCodeChange } from "./code-change-proposals";
import {
  applyControlPlaneChange,
  listControlPlaneChanges,
  proposeControlPlaneChange
} from "./control-plane-changes";
import { writeEvent } from "./events";
import { runHttpGet, runWebSearch } from "./web-tools";

const TOOL_SCHEMA_JSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["name", "version", "risk", "capabilities"],
  "properties": {
    "name": { "type": "string" },
    "version": { "type": "string" },
    "risk": { "type": "string", "enum": ["low", "medium", "high"] },
    "capabilities": { "type": "array", "items": { "type": "string" } },
    "inputs": { "type": "object" },
    "outputs": { "type": "object" }
  },
  "additionalProperties": true
}`;

function normalizeControlPlanePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".json")) return null;
  if (normalized.includes("..")) return null;
  return normalized;
}

export function buildAgentTools(context: AgentContext) {
  return {
    get_status: tool({
      description: "Get a summary of OpenCorpo's current state (approvals, jobs, tools, plugins, latest audit). Use this when the user asks about status, what's going on, or needs an overview.",
      inputSchema: z.object({}),
      execute: async () => buildStatusSummary(context)
    }),

    get_approvals: tool({
      description: "List pending or all approvals. Use when user asks about approvals, pending items, or what needs attention.",
      inputSchema: z.object({
        pending_only: z.boolean().optional().describe("If true, only show pending approvals")
      }),
      execute: async ({ pending_only }) =>
        buildApprovalsList(context.db, pending_only ?? true)
    }),

    approve: tool({
      description: "Approve a pending approval by ID. Use when user says to approve something.",
      inputSchema: z.object({
        approval_id: z.number().describe("The approval ID to approve")
      }),
      execute: async ({ approval_id }) =>
        handleApprovalAction(context.db, approval_id, "approved").text
    }),

    deny: tool({
      description: "Deny a pending approval by ID. Use when user says to deny something.",
      inputSchema: z.object({
        approval_id: z.number().describe("The approval ID to deny")
      }),
      execute: async ({ approval_id }) =>
        handleApprovalAction(context.db, approval_id, "denied").text
    }),

    list_jobs: tool({
      description: "List all jobs. Use when user asks about jobs, schedules, or automations.",
      inputSchema: z.object({}),
      execute: async () => buildJobsList(context.db)
    }),

    list_job_runs: tool({
      description: "List recent job runs. Use when user asks about job runs, execution history.",
      inputSchema: z.object({}),
      execute: async () => buildJobRunsList(context.db)
    }),

    run_job: tool({
      description: "Run a job by ID or name. Use when user wants to run/execute a job.",
      inputSchema: z.object({
        job_id: z.number().optional().describe("Job ID to run"),
        job_name: z.string().optional().describe("Job name to run (e.g. heartbeat)")
      }),
      execute: async ({ job_id, job_name }) => {
        if (job_id != null) return handleJobRun(context.db, job_id).text;
        if (job_name) return handleJobRunByName(context.db, job_name).text;
        return "Specify job_id or job_name to run a job.";
      }
    }),

    enable_job: tool({
      description: "Enable a job by ID.",
      inputSchema: z.object({ job_id: z.number() }),
      execute: async ({ job_id }) => handleJobToggle(context.db, job_id, true).text
    }),

    disable_job: tool({
      description: "Disable a job by ID.",
      inputSchema: z.object({ job_id: z.number() }),
      execute: async ({ job_id }) => handleJobToggle(context.db, job_id, false).text
    }),

    list_audit: tool({
      description: "List recent audit log entries. Use when user asks about audit, history, or what happened.",
      inputSchema: z.object({}),
      execute: async () => buildAuditList(context.db)
    }),

    get_audit_detail: tool({
      description: "Get details of a specific audit entry by ID.",
      inputSchema: z.object({ audit_id: z.number() }),
      execute: async ({ audit_id }) => handleAuditDetail(context.db, audit_id).text
    }),

    get_job_run_detail: tool({
      description: "Get details of a specific job run by ID.",
      inputSchema: z.object({ job_run_id: z.number() }),
      execute: async ({ job_run_id }) => handleJobRunDetail(context.db, job_run_id).text
    }),

    get_tool_run_detail: tool({
      description: "Get details of a specific tool run by ID.",
      inputSchema: z.object({ tool_run_id: z.number() }),
      execute: async ({ tool_run_id }) => handleToolRunDetail(context.db, tool_run_id).text
    }),

    list_tools: tool({
      description: "List registered tools. Use when user asks about capabilities or what tools are available.",
      inputSchema: z.object({}),
      execute: async () => buildToolsList(context.tools)
    }),

    get_tool_detail: tool({
      description: "Get details of a specific tool by name.",
      inputSchema: z.object({ tool_name: z.string() }),
      execute: async ({ tool_name }) => handleToolDetail(context.tools, tool_name).text
    }),

    list_plugins: tool({
      description: "List loaded plugins. Use when user asks about plugins, integrations, Gmail, connectors.",
      inputSchema: z.object({}),
      execute: async () => buildPluginsList(context.plugins)
    }),

    get_help: tool({
      description: "Get help on what OpenCorpo can do and example prompts.",
      inputSchema: z.object({}),
      execute: async () => buildHelpText()
    }),

    http_get: tool({
      description:
        "Fetch a public HTTP(S) URL. Use for docs pages and API responses. Private/local hosts are blocked.",
      inputSchema: z.object({
        url: z.string().url(),
        timeout_ms: z.number().min(1000).max(20000).optional(),
        max_bytes: z.number().min(512).max(100000).optional()
      }),
      execute: async ({ url, timeout_ms, max_bytes }) =>
        runHttpGet({ url, timeoutMs: timeout_ms, maxBytes: max_bytes })
    }),

    web_search: tool({
      description:
        "Search the public web for a query and return top links/snippets. Use when user asks to look something up.",
      inputSchema: z.object({
        query: z.string().min(1),
        max_results: z.number().min(1).max(10).optional()
      }),
      execute: async ({ query, max_results }) =>
        runWebSearch({ query, maxResults: max_results })
    }),

    list_available_handlers: tool({
      description:
        "List tool names that have plugin handlers. Use before adding a new tool to see which names can be used. Agent can add config for tools that match these handlers.",
      inputSchema: z.object({}),
      execute: async () => {
        const names = context.handlerNames ?? [];
        if (names.length === 0) return "No plugin handlers loaded. Install plugins to add tools.";
        return `Available handler names: ${names.join(", ")}. You can add tool definitions (tools/*.json) for these names.`;
      }
    }),

    get_tool_schema: tool({
      description:
        "Get the JSON schema for tool definitions. Use when creating a new tool via propose_config_change.",
      inputSchema: z.object({}),
      execute: async () => TOOL_SCHEMA_JSON
    }),

    get_ui_schema: tool({
      description:
        "Get the JSON schema for UI config files. Use before proposing ui/*.json changes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const schemaPath = resolve(context.controlPlaneRoot, "schemas/ui.schema.json");
          return readFileSync(schemaPath, "utf-8");
        } catch {
          return "UI schema not found.";
        }
      }
    }),

    get_control_plane_json: tool({
      description:
        "Read an existing control-plane JSON file (e.g. ui/desktop.json, tools/x.json, jobs/x.json) before editing.",
      inputSchema: z.object({
        relative_path: z
          .string()
          .describe("Path under config root, e.g. ui/desktop.json")
      }),
      execute: async ({ relative_path }) => {
        const normalized = normalizeControlPlanePath(relative_path);
        if (!normalized) return "Invalid control-plane path. Must be a safe .json relative path.";
        const absolutePath = resolve(context.controlPlaneRoot, normalized);
        if (!absolutePath.startsWith(resolve(context.controlPlaneRoot))) {
          return "Path traversal not allowed.";
        }
        if (!existsSync(absolutePath)) {
          return `File not found: ${normalized}`;
        }
        try {
          return readFileSync(absolutePath, "utf-8");
        } catch (err) {
          return `Failed to read ${normalized}: ${err instanceof Error ? err.message : "unknown_error"}`;
        }
      }
    }),

    list_control_plane_changes: tool({
      description: "List proposed/applied control plane changes. Use to check status of proposals.",
      inputSchema: z.object({}),
      execute: async () => {
        const changes = listControlPlaneChanges(context.db, 15);
        if (changes.length === 0) return "No control plane changes.";
        return changes
          .map(
            (c) =>
              `#${c.id} ${c.file_path} (${c.status}) ${c.risk} - ${c.summary ?? ""}`
          )
          .join("\n");
      }
    }),

    propose_config_change: tool({
      description:
        "Propose a change to control plane config (tools, jobs, workflows, ui, policy). Target: tools/*.json, jobs/*.json, workflows/*.json, ui/*.json, policy.json. High-risk requires approval.",
      inputSchema: z.object({
        relative_path: z
          .string()
          .describe("e.g. tools/mytool.json, jobs/daily.job.json"),
        after_json: z.record(z.unknown()).describe("The full JSON content for the file")
      }),
      execute: async ({ relative_path, after_json }) => {
        const normalized = relative_path.replaceAll("\\", "/").replace(/^\/+/, "");
        if (!normalized.endsWith(".json")) {
          return "Control plane changes must target .json files.";
        }
        if (normalized.includes("..")) return "Path traversal not allowed.";
        try {
          const proposed = proposeControlPlaneChange(context.db, context.controlPlaneRoot, {
            actor: "agent",
            relativePath: normalized,
            afterJson: after_json
          });
          if (!proposed.ok) {
            return `Config change rejected: ${(proposed as { details?: string[] }).details?.join("; ") ?? proposed.error}`;
          }
          const isHighRisk = proposed.risk === "high";
          if (isHighRisk) {
            const approvalId = createApproval(context.db, {
              requestedBy: "agent",
              tool: "control-plane.change",
              action: "apply",
              reason: `High-risk Control Plane change for ${normalized}`,
              metadata: { changeId: proposed.id }
            });
            writeAudit(context.db, {
              actor: "agent",
              action: "control_plane_change_proposed",
              metadata: { changeId: proposed.id, approvalId, path: normalized }
            });
            return `Proposed control-plane change #${proposed.id} for ${normalized}. Approval #${approvalId} is required before apply.`;
          }
          const applied = applyControlPlaneChange(context.db, context.controlPlaneRoot, proposed.id);
          if (applied.ok && context.onControlPlaneChanged) {
            await context.onControlPlaneChanged();
          }
          writeAudit(context.db, {
            actor: "agent",
            action: applied.ok ? "control_plane_change_applied" : "control_plane_change_failed",
            metadata: { changeId: proposed.id, path: normalized }
          });
          return applied.ok
            ? `Applied control-plane change #${proposed.id} (${normalized}).`
            : `Change #${proposed.id} was not applied: ${applied.error}.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }),

    propose_code_change: tool({
      description:
        "Propose a Tier B code change to userland workspace. Requires user approval. Target: .ts, .tsx, .js, .json, .md, .txt in workspace.",
      inputSchema: z.object({
        target_path: z.string().describe("Relative path in workspace, e.g. notes.ts"),
        after_content: z.string().describe("The new file content")
      }),
      execute: async ({ target_path, after_content }) => {
        try {
          const proposal = proposeCodeChange(context.db, context.workspaceRoot, {
            actor: "agent",
            targetPath: target_path,
            afterContent: after_content,
            reason: "Agent requested workspace change."
          });
          const approvalId = createApproval(context.db, {
            requestedBy: "agent",
            tool: "workspace.patch",
            action: "apply",
            reason: `Tier B code change requires approval (${target_path}).`,
            metadata: { codeChangeProposalId: proposal.id, targetPath: target_path }
          });
          attachCodeChangeApproval(context.db, proposal.id, approvalId);
          writeAudit(context.db, {
            actor: "agent",
            action: "code_change_proposed",
            metadata: { proposalId: proposal.id, approvalId, path: target_path }
          });
          writeEvent(context.db, {
            type: "code_change.proposed",
            data: { proposalId: proposal.id, approvalId }
          });
          return `Proposed workspace code change #${proposal.id} for ${target_path}. Approval #${approvalId} is required.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }),

    apply_control_plane_change: tool({
      description:
        "Apply a proposed control plane change by ID. Only works for changes that are approved or low-risk.",
      inputSchema: z.object({
        change_id: z.number().describe("The control plane change ID to apply")
      }),
      execute: async ({ change_id }) => {
        const applied = applyControlPlaneChange(context.db, context.controlPlaneRoot, change_id);
        if (!applied.ok) return `Failed: ${applied.error}`;
        if (context.onControlPlaneChanged) {
          await context.onControlPlaneChanged();
        }
        return `Applied change #${change_id}.`;
      }
    })
  };
}
