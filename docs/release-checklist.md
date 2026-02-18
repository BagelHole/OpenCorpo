# OpenCorpo Desktop Release Checklist

## Channels

- `stable`: default public release channel.
- `beta`: pre-release channel for early adopters.
- `dev`: fast iteration channel for contributors.

## Build Commands

- `npm run build:desktop`
- `npm run pack:desktop`
- `npm run dist:desktop`

## Smoke Tests

- `npm run test:smoke`
- Manual launch test:
  - install package
  - verify daemon auto-starts
  - verify onboarding wizard appears
  - verify chat, inbox, settings, diagnostics load

## Preflight Security

- verify launch token generated and not default
- verify high-risk actions require approval
- verify audit integrity check passes in diagnostics

## Connectors

- Codex OAuth flow opens browser and callback stores token
- MCP server settings save/reload successfully
- MCP tools are invokable by the AI and visible in tool runs

## Packaging Targets

- macOS: `dmg`, `zip`
- Windows: `nsis`, `zip`
- Linux: `AppImage`, `deb`

## Sign-off

- change log updated
- README run/install docs updated
- known issues documented
