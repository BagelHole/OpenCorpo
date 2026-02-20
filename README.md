<div align="center">
  <img src="./OpenCorpo.png" alt="OpenCorpo" width="1000" />

  **OpenCorpo: Self-editing, local-first operating system powered by an AI operator.**

  <p>
    <a href="#quick-start">Quick Start</a> •
    <a href="#features">Features</a> •
    <a href="#use-cases">Use Cases</a> •
    <a href="#installation">Installation</a> •
    <a href="#architecture">Architecture</a> •
    <a href="#security-model">Security</a> •
    <a href="#roadmap">Roadmap</a>
  </p>

  <p>
    <img alt="Status" src="https://img.shields.io/badge/status-early%20beta-ffb020" />
    <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun%20%2B%20Node-111827" />
    <img alt="Desktop" src="https://img.shields.io/badge/desktop-Electron%20%2B%20React-2563eb" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-16a34a" />
  </p>

  <img src="./OpenCorpo.gif" alt="OpenCorpo demo" width="1000" />
</div>

---

## OpenCorpo: Local-First AI OS

OpenCorpo is an **AI-powered operating system** you run locally.  
It combines **agent chat, job automation, approvals, auditing, and self-editing UI/workflow config** in one desktop app.

If you are searching for:
- local-first AI automation platform
- AI workflow engine for desktop
- self-hosted AI operations tool
- AI agent with approvals and audit logs

OpenCorpo is built for exactly that direction.

## What OpenCorpo Is

OpenCorpo is a desktop-first, local AI operating system for business workflows.

It combines:
- an Electron desktop app for chat, approvals, audits, and operations
- a local Bun daemon for tools, jobs, policies, and agent runtime
- a declarative control plane the AI can edit safely

The design goal is simple: **let AI act without making your system dangerous**.

## Features

- Local-first desktop runtime (Electron + Bun daemon)
- AI chat + operations control from one app
- Scheduled and manual jobs with run history
- Control-plane driven product surface (`config/**/*.json`)
- Self-edit proposals with validation and approval flow
- Built-in audit logs for sensitive actions
- Policy/risk gates for tool execution
- Tool/plugin model for extensibility
- UI builder blocks (`markdown`, `stats`, `note`, `job_table`, `react_widget`, `web_embed`, `terminal_widget`)
- Multi-platform packaging targets (Windows, macOS, Linux)

## Self-Editing

OpenCorpo is not just a chatbot. It can **edit and evolve its own product surface** through a validated control plane.

Out of the box, the AI can:
- add/edit sidebar routes and pages in `ui/desktop.json`
- compose new pages with markdown, notes, stats, and job-driven tables
- embed live web experiences with `web_embed` (iframe-backed blocks)
- add npm-powered `react_widget` components to pages
- spin up `terminal_widget` blocks for interactive command output
- propose config/code changes with previews, approvals, and audit trails

## Why It Exists

Most AI products stop at chat. OpenCorpo is built for execution:
- plan and run work
- schedule recurring jobs
- reconfigure workflows through validated JSON
- keep every important action auditable

## Use Cases

- Internal operations copilots for founder teams
- Automated trend, market, or competitor monitoring
- Agent-driven dashboards backed by recurring jobs
- Approval-gated workflow automation for sensitive tasks
- Local development sandbox for autonomous business tooling

## Feature Highlights

### 1) Job Engine + Scheduling
- Queue and run jobs manually or on schedule
- Observe run states (`queued`, `running`, `completed`, `failed`, `waiting_approval`)
- Render job outputs directly into UI blocks

### 2) Safe Agent Actions
- Policy checks before tool execution
- High-risk flows can require human approval
- Capability-scoped tool access instead of unrestricted execution

### 3) Self-Editing Control Plane
- Propose and apply schema-validated config changes
- Update pages, tools, jobs, workflows, and policy with diffs
- Keep edits auditable and reversible through version control

### 4) Desktop-First Operator Experience
- Onboarding + provider setup
- Chat, Jobs, Settings, and Audit views
- Built-in daemon supervision and health checks

## Inspired By OpenClaw

OpenCorpo is inspired by the direction and momentum of [OpenClaw](https://github.com/openclaw/openclaw), especially around practical local-first agent workflows and strong docs ergonomics.

If you like this project, you should absolutely check OpenClaw out too.

## Quick Start

### 1) Prerequisites

- Node.js 18+ (Node 20/22 recommended)
- Bun 1.x on your PATH
- npm (ships with Node)

### 2) Install dependencies

```bash
npm install
```

### 3) Run desktop (recommended)

```bash
npm run dev:desktop
```

This starts the desktop app; OpenCorpo will boot/supervise the daemon for you.

### 4) Optional: run daemon only (debug)

```bash
bun run dev:daemon
```

## Installation

### Local Development Install (from source)

```bash
git clone https://github.com/BagelHole/OpenCorpo.git
cd OpenCorpo
npm install
npm run dev:desktop
```

### Build Desktop App

```bash
npm run build:desktop
```

### Package Desktop App

```bash
npm run pack:desktop
```

### Create Distributables

```bash
npm run dist:desktop
```

Packaged desktop builds can bundle Bun via `apps/desktop/scripts/prepare-bun-runtime.mjs` when Bun is available on the build machine.
Release artifacts are written to `dist/desktop/`.
Platform-specific commands:
- `npm run dist:desktop:win`
- `npm run dist:desktop:mac`
- `npm run dist:desktop:linux`
Cross-platform note: build each target on its native OS (Windows for `.exe`, macOS for `.dmg`, Linux for `.AppImage/.deb`) or use CI matrix builds.

### Release (GitHub + Website Downloads)

Current desktop version: `0.1.0`

1. Build artifacts locally:

```bash
npm run dist:desktop
```

2. Upload files from `dist/desktop/` to a GitHub Release (recommended assets: `.exe`, `.dmg`, `.AppImage`, `.deb`, `.zip`).
3. To auto-build and auto-upload from CI, push a release tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow at `.github/workflows/release-desktop.yml` builds macOS, Windows, and Linux packages and publishes them to that GitHub release.

## Developer Commands

| Command | Purpose |
| --- | --- |
| `npm run dev:desktop` | Run desktop app in development mode |
| `npm run dev:renderer` | Run React renderer only |
| `npm run dev:electron` | Run Electron shell only |
| `npm run dev:daemon` | Run daemon directly via Bun |
| `npm run test:smoke` | Run daemon + desktop smoke checks |

## Architecture

```mermaid
flowchart TB
  UI[Desktop UI\nElectron + React] -->|localhost HTTP + SSE + token| D[Local Daemon\nBun + Elysia]
  D --> CP[Control Plane JSON]
  D --> DB[(SQLite)]
  D --> TOOLS[Tools + Jobs + Policies]
  D --> AUDIT[Immutable Audit Log]
```

### Core Components

- `apps/desktop`: desktop shell + renderer UI
- `apps/daemon`: local API, agent runtime, orchestration
- `config/`: declarative control plane (policy/tools/jobs/ui)
- `data/`: runtime mutable config and state
- `userland/`: workspace for explicit Tier-B code changes

## Control Plane Philosophy

OpenCorpo defaults to **declarative mutation**:
- AI edits JSON control-plane config first
- every change is schema-validated
- diffs can be previewed before apply
- policy checks and risk gating happen before execution
- audit records are append-only

Tier model:
- Tier A: config edits (`config/**/*.json`) (default)
- Tier B: code patches (rare, explicit, user-approved)

## Security Model

### Tool-only execution

The agent does not get implicit DB or network access. It must use registered tools.

### Capability gating

Each tool/job requires explicit capabilities that are scoped and revocable.

### Policy + approvals

Risky actions can be blocked or require approval.

### Immutable auditing

Important events include actor, action, policy decision, timestamps, and correlation metadata.

## AI Providers

OpenCorpo supports pluggable providers through the AI SDK setup.

Current UX includes:
- API-key based provider setup
- Codex ChatGPT subscription OAuth path in Settings (`Codex (ChatGPT)`)

## Current Status

OpenCorpo is in **very early beta**.

Expect:
- breaking changes
- evolving schemas/APIs
- incomplete features
- rapidly improving docs

## Roadmap

- production-hardening for packaged desktop runtime
- stronger long-running planner/worker behavior
- richer workspace patch previews in the desktop UI
- release channel automation (stable/beta/dev)
- version control
- centralized admin server that ingests audit logs from instances
- more models + providers
- more custom integrations/plugins
- background daemon running 24/7 - allow agent to work all day

## Contributing

Contributions are welcome.

- open Issues for bugs and proposals
- submit focused PRs
- prefer small, reviewable changes
- prioritize safety, auditability, and local-first behavior

## License

MIT
