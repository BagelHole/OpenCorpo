# OpenCorpo Master TODO

This is the long-horizon build list. It is intentionally large and broken into phases. Items marked [MVP] are required for the first usable local release.

## Progress (last updated: 2026-02-01)
- Completed: root workspace setup, daemon core scaffold, approvals/jobs/tools loop, Control Plane validation, SSE stream, plugin loader, and Electron desktop UI shell.
- In progress: UI wiring depth (details, schedules, approvals), job scheduling fidelity, MCP tool/integration depth.

## Phase 0 - Foundations
- [x] [MVP] Decide repo tooling: Bun workspaces or plain pnpm
- [x] [MVP] Add root package.json + workspace config
- [ ] [MVP] Add lint/format (eslint + prettier) baseline
- [ ] [MVP] Define env var contract (OPENCORPO_*), document in README
- [ ] [MVP] Establish versioning + release cadence

## Phase 1 - Daemon Core
- [x] [MVP] Health/auth endpoints + launch token
- [ ] [MVP] SQLite schema migrations system
- [x] [MVP] Audit log append-only writer
- [x] [MVP] Event emitter + SSE stream
- [x] [MVP] Approvals queue + state transitions
- [x] [MVP] Jobs tables + basic scheduler
- [x] [MVP] Job runner for declarative steps
- [x] [MVP] Tool registry + tool execution pipeline
- [x] [MVP] Control Plane loader + schema validation
- Add DB backup/restore flow
- Add DB encryption toggle (SQLCipher)
- Add daemon lifecycle (start/stop/reload config)
- Add system tray control channel

## Phase 2 - Control Plane
- [x] [MVP] JSON schemas for tools/policy/jobs/workflows/ui
- [x] [MVP] Validation results surfaced in API
- [ ] [MVP] Reject invalid config changes
- Add config diff preview
- Add config simulator for workflows/jobs
- Add schema versioning + migration for control plane
- Add UI schema renderer

## Phase 3 - Security + Policy
- [x] [MVP] Capability enforcement in tool calls
- [x] [MVP] Policy engine allow/deny/approve
- [x] [MVP] Approval enforcement for high risk tools
- Add capability grants + time-bound caps
- Add scoped network allowlist enforcement
- Add risk scoring per tool + per job step
- Add policy lint tool
- Add policy audit trail
- Add redaction policy for audit/event payloads

## Phase 4 - Jobs + Automations
- [x] [MVP] Declarative job runner
- [x] [MVP] Job run status + output storage
- [x] [MVP] Job scheduler interval support
- [x] Add cron parsing + timezone support
- Add workflow triggers (event-based)
- Add job cancellation + retry policy
- Add job concurrency limits
- Add step-level timeout + retry
- Add script-job sandbox (TypeScript)

## Phase 5 - Plugins + Tools
- [x] [MVP] Plugin manifest + loader
- [x] [MVP] Tool handler registration
- [ ] Add plugin signing + verification (enterprise mode)
- [ ] Add plugin permission prompts
- [x] Add tool metadata registry endpoints
- [x] Add tool input validation against schemas
- [ ] Add plugin lifecycle (enable/disable/update)

## Phase 6 - Desktop UI (Electron)
- [x] [MVP] Shell window + daemon connection
- [x] [MVP] Chat surface
- [x] [MVP] Approvals inbox
- [x] [MVP] Jobs view
- [x] [MVP] Audit log viewer
- Add UI for Control Plane validation errors
- Add UI for policies + capabilities
- Add UI for workflows + schedules
- Add toast notifications + tray notifications

## Phase 7 - Agent Runtime
- [x] [MVP] Tool calling interface
- [x] [MVP] Tool call/approval flow
- [ ] [MVP] Planner/worker loop
- [x] Chat session storage + basic agent echo
- Add task memory + summaries
- Add instruction hierarchy (org/user/session)
- Add long-running tasks + checkpoints
- Add tool execution tracing

## Phase 8 - API + Integrations
- [x] [MVP] Local API v1
- Add webhook bridge (local-only)
- Add local graph view for entities
- Add import/export for data
- Add CSV/ICS adapters
- Add BYOK provider adapter

## Phase 9 - Observability + Testing
- [ ] [MVP] Basic smoke tests for daemon
- [ ] [MVP] Schema validation tests
- Add integration tests for approvals/jobs
- Add plugin harness tests
- Add UI tests (Playwright)
- Add performance profiling
- Add audit log integrity verifier

## Phase 10 - Packaging + Release
- [ ] [MVP] Build scripts for desktop + daemon
- [ ] [MVP] Installer flow
- Add auto-update support
- Add migration strategy for DB + config
- Add telemetry (optional, off by default)
- Add licensing checks (enterprise mode)

## Stretch
- Multi-tenant workspaces
- Per-user roles + RBAC
- Partial replication sync
- Offline first-run bootstrap wizard
- Visual workflow editor
- Native email client view
