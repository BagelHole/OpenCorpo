# OpenCorpo QA Matrix

## Core Flows

| Flow | Expected Result |
| --- | --- |
| First launch | Daemon auto-starts and onboarding wizard opens |
| Complete onboarding | User lands in Home Chat without technical setup screens |
| Send chat prompt | Assistant responds and stores history |
| Approval action | Approve/Deny updates inbox + audit |
| Job run | Job appears in recent runs and status updates |
| Diagnostics run | Checks and recommendations render in settings |

## Self-Editing Flows

| Flow | Expected Result |
| --- | --- |
| Control-plane proposal low risk | Change applies directly and audit entry is written |
| Control-plane proposal high risk | Approval is created before apply |
| Workspace code proposal | Approval is required before patch apply |
| Rejected proposal | Proposal remains unapplied |

## Connector Flows

| Flow | Expected Result |
| --- | --- |
| Gmail manual token | Connector status becomes connected |
| Gmail OAuth | Browser auth URL opens and callback persists token |
| Gmail search/read | Structured responses with ids/message details |
| Gmail draft/send | Draft/message IDs return on success |

## Platform Build Targets

| Target | Command |
| --- | --- |
| macOS package | `npm run dist:desktop` |
| Windows package | `npm run dist:desktop` |
| Linux package | `npm run dist:desktop` |
