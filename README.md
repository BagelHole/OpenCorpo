# OpenCorpo

OpenCorpo is a local-first, business operating system powered by an AI agent that can read, act, schedule work, and safely reconfigure its own system.

This is a chatbot and a self-configuring business OS with security and auditing.

## Early Beta Warning

OpenCorpo is in **very early beta**.

What this means right now:

- breaking changes are expected
- schemas, APIs, and config formats can change without notice
- features may be incomplete or unstable
- documentation may lag behind the latest code
- data migrations may be imperfect between versions

If you use OpenCorpo today, treat it as an experimental system and avoid relying on it for production-critical workflows.

## Open Source Project Notes

OpenCorpo is open source and community contributions are welcome.

- use Issues for bugs, regressions, and feature proposals
- use PRs for focused changes with clear scope
- prefer small, reviewable patches over large refactors
- expect maintainers to prioritize safety, auditability, and local-first behavior over feature speed

## Core vision

Let the AI work on the system without making the system dangerous.

OpenCorpo is built so that:

- 80-95% of customization happens via declarative config
- AI edits validated JSON, not code
- all changes are previewed, policy-checked, and audited
- code edits are rare, explicit, gated, and reviewed
- every action is explainable after the fact

## Non-negotiable principles

- Local-first
  - SQLite on disk
  - offline capable
  - no required cloud backend
- Agent can act
  - AI can edit data, send messages, and run jobs
  - only via registered tools
  - no implicit DB or network access
- Declarative-first
  - tools, policies, workflows, jobs, schemas, UI are config
  - AI edits config by default
- Enterprise-grade security
  - capability-based permissions
  - policy enforcement + approvals
  - immutable audit log
  - encrypted secrets
- No slop
  - schemas everywhere
  - explicit risk levels
  - deterministic tooling
  - aggressive defaults

## High-level architecture

OpenCorpo consists of two local processes:

1) Desktop app (Electron + React UI)
   - chat, jobs, CRM, approvals, audit viewer
   - OAuth flows (Gmail)
   - system tray + lifecycle
   - starts and authenticates the daemon

2) Local daemon (Bun + Elysia)
   - binds to 127.0.0.1
   - owns all data, tools, jobs, policies, and plugins
   - hosts the AI runtime
   - enforces security, approvals, auditing

Diagram:

+---------------------------+
|        Desktop UI         |  Electron
|  - chat / jobs / crm      |
|  - jobs / approvals       |
|  - audit viewer           |
|  - oauth                  |
+------------+--------------+
             | localhost (HTTP + WS)
             | per-launch auth token
+------------v--------------+
|        Bun Daemon         |  Elysia
|  - sqlite                 |
|  - agent runtime          |
|  - tool + job registry    |
|  - control plane          |
|  - policy engine          |
|  - audit log              |
+---------------------------+

## Tech stack

- Runtime: Bun
- API: Elysia
- Desktop: Electron (Vite + React + shadcn)
- Database: SQLite + FTS5
- Language: TypeScript everywhere
- AI runtime: Vercel AI SDK (ai-sdk.dev) with pluggable providers (OpenAI, Codex ChatGPT subscription OAuth, local models, BYOK)

## Control plane (first-class)

The Control Plane is a declarative layer that defines how OpenCorpo behaves. It exists so the AI can safely modify the system without touching executable code.

Governed by the Control Plane:

- tool definitions and risk
- policies and approvals
- workflows / automations
- jobs and schedules
- data schemas and fields
- UI composition
- audit redaction rules

All Control Plane files are:

- JSON
- strictly schema-validated
- diffable
- previewable
- audited on change

## Tiered customization model

### Tier A - declarative (default)

AI is allowed to edit:

- config/**/*.json
- tools, policies, workflows, jobs, schemas, UI layouts

Desktop navigation and base pages are now declarative in `config/ui/desktop.json` and validated by `config/schemas/ui.schema.json`.
The AI can add sidebar items, interactive action buttons, and sandboxed npm React widgets there without code changes.
App-level theming is also declarative there via a top-level `theme` object (`light`/`dark` tokens for colors, radii, shadows, and fonts).

In desktop runtime, mutable user-specific Control Plane state is stored under the runtime data directory (`data/config` in local dev, app runtime folder in packaged builds). Do not commit those runtime JSON changes.

Flow:

- propose change
- validate
- preview
- apply
- audit

### Tier B - code (rare)

When config is insufficient:

- AI proposes a patch
- tests and checks run
- user explicitly approves
- patch applied to userland/workspace

Goal: Tier B < 10% of changes.

## AI self-editing pipeline

When the AI modifies OpenCorpo itself:

- Change proposal
  - files to edit
  - what changes
  - why
  - risk impact
- Validation
  - JSON schema validation
  - policy linting
  - capability expansion detection
  - dangerous diff detection
- Preview
  - UI diffs
  - workflow simulation
  - job simulation
  - approval changes
- Apply
  - change applied
  - immutable audit entry written
  - diff hash stored

## Repository layout

opencorpo/
  apps/
    daemon/                  # Bun + Elysia backend
    desktop/                 # Electron shell + React UI
  packages/
    core/                    # DB + migrations
    agent/                   # tools, policies, jobs
    plugin-sdk/              # plugin interfaces
    ui-kit/
  plugins/
    gmail/
  config/                    # CONTROL PLANE (AI-editable)
    policy.json
    tools/
    modules/
    workflows/
    jobs/
    ui/
    redaction.json
  userland/
    workspace/               # AI code patches (Tier B)
    jobs/                    # sandboxed job scripts
  docs/
    architecture/
    security/

Note: folders exist as scaffolding today and will be filled in progressively.

## Security model (enterprise-grade)

### Tool-only execution

The AI:

- cannot access the DB directly
- cannot make network calls directly
- can only call registered tools

### Capability-based permissions

Each tool/job requires explicit capabilities that are scoped, revocable, and optionally time-bound.

### Policy + approvals

Actions are classified by risk. High-risk actions require approval by default.

Low-risk examples:

- tagging
- notes
- CRM field updates
- reports

High-risk examples:

- sending external email
- deleting data
- exporting data
- running scripts
- installing plugins

### Immutable audit log

Every meaningful action produces an append-only audit entry:

- actor (user / agent / plugin / job)
- action type
- tool/job name + version
- policy decision
- capability snapshot
- timestamps
- correlation IDs
- optional hash chaining

Audit entries are never mutated or deleted.

### Secrets and encryption

- OAuth tokens stored in the OS keychain
- SQLite workspace supports encryption
- secrets referenced, never stored in plaintext
- optional passphrase mode

## Plugin system

Plugins provide:

- connectors (Gmail first)
- tools callable by the agent
- background sync jobs

Trust model:

- Open-source mode (default): unsigned plugins allowed
- Enterprise mode (future): plugin signing enforced

All plugins:

- declare permissions
- are capability-gated
- are audited

## First connector: Gmail

Gmail responsibilities:

- OAuth authentication
- incremental sync
- emit events for messages and threads

Gmail tools:

- gmail.search
- gmail.read
- gmail.draft
- gmail.send (high-risk, approval required)

## Jobs and scheduled automations

OpenCorpo supports first-class scheduled jobs that the AI can create and manage.

Jobs are:

- declarative by default
- permissioned
- sandboxed
- scheduled
- fully audited

### Job types

Type A - declarative jobs (default)

- built from safe primitives
- no executable code
- preferred by AI

Type B - script jobs (rare)

- TypeScript scripts
- run in sandboxed workers
- require approval by default

## Data model (core tables)

- entities
- events
- documents
- tasks
- jobs
- job_runs
- audit_log
- capabilities
- plugin_registry
- secret_refs

Rule: any state change must emit an event and write an audit entry.

## Local API (v1)

All endpoints require:

- Authorization: Bearer <launch_token>

HTTP:

- GET /health
- POST /auth/session
- GET /auth/grants
- POST /auth/grants/:id/revoke
- GET /events
- GET /audit
- GET /audit/:id
- GET /chat/sessions
- GET /chat/sessions/:id
- POST /chat/sessions
- GET /chat/messages?sessionId=:id
- POST /chat/messages
- GET /jobs
- GET /jobs/:id
- GET /jobs/runs
- GET /jobs/runs/:id
- POST /jobs
- POST /jobs/run/:id
- POST /jobs/:id/enable
- POST /jobs/:id/disable
- POST /tools/:toolName
- GET /tools
- GET /tools/registry
- GET /tools/runs
- GET /tools/runs/:id
- GET /ui/config
- GET /plugins
- GET /approvals
- GET /approvals/:id
- POST /approvals
- POST /approvals/:id/approve
- POST /approvals/:id/deny
- GET /diagnostics
- GET /diagnostics/runs
- POST /diagnostics/repair
- POST /control-plane/reload
- GET /control-plane/changes
- POST /control-plane/changes/propose
- POST /control-plane/changes/:id/apply
- POST /control-plane/changes/:id/reject
- GET /code/changes
- POST /code/changes/propose
- POST /code/changes/:id/reject
- POST /code/changes/:id/apply
- GET /connectors/gmail/status
- POST /connectors/gmail/token
- GET /connectors/gmail/oauth/start
- GET /oauth/google/callback
- GET /connectors/codex/status
- GET /connectors/codex/oauth/start
- GET /oauth/openai/callback
- POST /connectors/codex/disconnect

WebSocket:

SSE:

- GET /stream (supports `?token=` for SSE clients)
  - events
  - approvals
  - job status
  - agent state

## MVP success criteria

A user can:

- run OpenCorpo locally
- connect Gmail
- ask AI questions
- approve AI actions
- let AI create daily jobs
- receive reports
- inspect audit logs
- watch AI reconfigure workflows safely

## Status

**Very early beta (active rebuild).**

Current focus:

- desktop-first onboarding and local daemon supervision
- diagnostics and recovery workflows
- safe self-edit and control-plane mutation flows

The desktop shell and daemon both live in this repository under `apps/desktop` and `apps/daemon`.

## Immediate next steps (coding agent)

- harden production packaging with bundled Bun runtime
- finish OAuth polish + token refresh handling for Gmail
- expand planner/worker intelligence for long-running tasks
- add richer workspace patch diff previews in desktop UI
- complete release channel automation (stable/beta/dev)

## Running the current demo

Desktop app (daemon auto-starts):

```
npm run dev:desktop
```

Packaged desktop builds include a bundled Bun runtime when available on the build machine (`apps/desktop/scripts/prepare-bun-runtime.mjs`).

Daemon only (debug mode):

```
bun run dev:daemon
```

Optional AI provider key (Electron bridge):

```
export AI_GATEWAY_API_KEY=your_key
# or: export VERCEL_AI_API_KEY=your_key
```

Codex ChatGPT subscription setup:

- In Settings, choose `Codex (ChatGPT)` as AI provider.
- Click `Connect ChatGPT`, complete OAuth in browser, then return to OpenCorpo.
- This path uses ChatGPT subscription OAuth (personal/dev use), not OpenAI Platform API credits.

## License

MIT
