# Hilbras Studio — Roadmap

**v0.1.0 → v1.0.0: from platform integrations to a Goal-Driven AI Runtime.**

> Instead of users manually defining how platforms and AI should interact, they
> define what they want to accomplish. The Runtime handles planning, execution,
> scheduling, tools, platform connections, accounts, permissions, and monitoring.

Architecture and layer contracts: [`docs/architecture.md`](docs/architecture.md).
Release history: [`CHANGELOG.md`](CHANGELOG.md).

---

## Version ladder

```
v0.1.0  (current)
   │
   ▼
v0.2.0 — Architecture Foundation
   ▼
v0.3.0 — Runtime Foundation
   ▼
v0.4.0 — Multi-Account Connections
   ▼
v0.5.0 — Unified Platform API
   ▼
v0.6.0 — Goal Engine
   ▼
v0.7.0 — AI Planning
   ▼
v0.8.0 — Human-in-the-Loop
   ▼
v0.9.0 — Studio 2.0
   ▼
v0.9.5 — Release Candidate
   ▼
🚀 v1.0.0 — Goal-Driven AI Runtime
```

---

## Phase 0 — Baseline & Architecture → **v0.2.0**

Establish the architectural foundation for the Runtime transition.

- [x] Review the current v0.1.0 architecture.
- [x] Identify existing functionality that should remain.
- [x] Define the new core layers: Studio UI, Runtime, AI Layer, Connectors,
      Accounts & Connections, Tools.
- [x] Define boundaries between each layer.
- [x] Document major architecture decisions (ADR-001 … ADR-007).
- [x] Establish versioning conventions (ADR-007, SemVer).
- [x] Create `CHANGELOG.md`.
- [x] Update `README.md`.
- [x] Create `docs/architecture.md`.
- [ ] Resolve the open questions in `docs/architecture.md` §6.
- [ ] Complete remediation Task 0 (local secret inventory and rotation).
- [ ] Commit, tag `v0.2.0`, publish the GitHub Release.

---

## Phase 1 — Runtime Foundation → **v0.3.0**

The Runtime executes tasks instead of Studio simply connecting platforms together.

```
Goal → Runtime → Plan → Tasks → Execution → Result
```

- [x] Define execution state: pending, running, completed, failed, cancelled
      (plus `awaiting_approval` as a suspension) — `src/lib/runtime/state.ts`,
      with an exhaustive state × event test.
- [x] **Define the `Connector` / `Capability` interface and wrap the five
      existing publishers in it** (ADR-002 — pulled forward from Phase 3) —
      `src/lib/connectors/`, documented in `docs/connectors.md`.
- [ ] Runtime Engine on the durable queue (ADR-001).
- [ ] Define `Goal`, `Task`, `Run` — the state machine and connector interface
      are done; the persistence model is not.
- [ ] Execution history.
- [ ] Runtime logging.
- [ ] Error handling and a basic retry mechanism — `shouldRetry` and
      `ConnectorError.retryable` are in place; the executor loop is not.
- [ ] Persist execution state.

**Docs:** `architecture.md` ✅, `connectors.md` ✅, `runtime.md`, `goals.md`,
`execution.md`

**Progress:** first increment landed. The two pure cores — the connector
contract and the execution state machine — are complete and tested, which is the
part that everything else depends on and the part ADR-002 existed to protect.

---

## Phase 2 — Accounts & Connections → **v0.4.0**

Multiple accounts per platform, with a proper connection/account model (ADR-006).

```
X                     LinkedIn
├── @Hilbras          ├── Hassan
├── @HilbrasAI        └── Hilbras
└── @Personal
```

- [ ] `Connection` model and `Account` model.
- [ ] OAuth management; secure token storage.
- [ ] Discover available platform accounts.
- [ ] Multiple accounts per platform; enable/disable; disconnect.
- [ ] Account permissions.
- [ ] Handle expired/revoked credentials.
- [ ] Select specific accounts for Goals.
- [ ] Migration + backfill for `social_accounts` and `posts.platforms`.
- [ ] Fix `getConnectedAccount()`, which currently targets only the newest
      account (`.limit(1)` by `connectedAt`).

**Docs:** `accounts.md`, `connections.md`, `authentication.md`
**Migration notes required.**

---

## Phase 3 — Unified Platform API → **v0.5.0**

The Runtime depends on standardized capabilities, never on platform APIs.

- [ ] Connector interface *(defined in Phase 1 — standardised here)*.
- [ ] Capability interface: `create_post`, `publish_post`, `get_posts`,
      `get_account`, `delete_post`.
- [ ] Standardized responses and errors.
- [ ] Capability discovery; map accounts to available capabilities.
- [ ] Idempotency-key result cache on every side-effecting capability (ADR-005).
- [ ] Platform adapters for the remaining registries.
- [ ] Document connector development standards.

**Docs:** `connectors.md`, `capabilities.md`, `platform-development.md`

> **Open:** LinkedIn, TikTok, YouTube, Pinterest, and Reddit are `connect_only`
> today. See `docs/architecture.md` §6.

---

## Phase 4 — Goal Engine → **v0.6.0**

Users describe what they want instead of building workflows by hand.

> "Publish two posts about AI every day on LinkedIn and X."

```json
{
  "goal": "Publish two AI posts every day",
  "schedule": "daily",
  "accounts": ["linkedin:hilbras", "x:hilbras"]
}
```

- [ ] Goal creation, parsing, validation, configuration.
- [ ] Scheduling and constraints.
- [ ] Target accounts.
- [ ] Goal status, history, editing, pause/resume.

**Docs:** `goals.md`, `scheduling.md`, `goal-engine.md`

---

## Phase 5 — AI Planning → **v0.7.0**

```
Goal → AI Planner → Execution Plan → Runtime
```

Example plan: research topics → generate ideas → generate posts → validate →
publish → verify → report.

- [ ] AI Planner and tool selection.
- [ ] Generate and validate execution plans.
- [ ] Execute plans through the Runtime.
- [ ] Re-planning; context management; execution limits.
- [ ] Handle AI failures; prevent unauthorized tool usage.
- [ ] Per-run and per-step AI spend limits.

**Docs:** `ai/planner.md`, `ai/tools.md`, `ai/context.md`, `runtime/planning.md`

---

## Phase 6 — Human-in-the-Loop → **v0.8.0**

The Runtime pauses and requests approval for sensitive or configurable actions.

```
AI → Generate Post → Approval Required → User → Approve → Runtime → Publish
```

- [ ] Approval system; pending actions.
- [ ] Approve, reject, edit-before-approval.
- [ ] Approval timeout.
- [ ] Execution policies; per-tool and per-account approval settings.
- [ ] Action permissions.

```
Publishing:  [ Auto ]  [ Approval Required ]  [ Disabled ]
```

> Durable suspension across hours or days comes from the queue's wait/sleep
> primitives (ADR-001) — this is why the managed queue was chosen.

**Docs:** `approvals.md`, `permissions.md`, `policies.md`

---

## Phase 7 — Studio UI 2.0 → **v0.9.0**

Redesign Studio around the Runtime instead of around integrations.

- [ ] Runtime dashboard (status, running goals).
- [ ] Goals dashboard and creation/configuration UI.
- [ ] Account and connection management.
- [ ] Execution history and runtime logs.
- [ ] Approval interface and runtime controls.
- [ ] Error management; usage metrics.

**Docs:** user guide under `src/app/docs/*`

---

## Phase 8 — v1.0 Hardening → **v0.9.5**

**Reliability** — crash recovery, retry policies, idempotency, rate limiting,
queue management, concurrent execution, timeout handling, persistent execution
state, graceful shutdown, recovery from interrupted runs.

**Security** — secrets encryption, OAuth security, permission system, tool
permissions, account isolation, audit logs, secure credential lifecycle.

**Testing** — unit, integration, Runtime, connector, AI Planner, failure
scenario, end-to-end, and security tests.

**Docs finalize** — `architecture`, `runtime`, `goals`, `accounts`, `connections`,
`connectors`, `capabilities`, `scheduling`, `security`, `permissions`,
`deployment`, `development`, `ai/*`.

---

## Phase 9 — v1.0.0

```
Create Goal → Select Accounts → Set Schedule → Runtime → AI Planning
  → Execution → Approval (if required) → Monitoring → Result
```

### v1.0.0 requirements

- [ ] Runtime is stable.
- [ ] Goals are fully supported.
- [ ] Multiple accounts are supported.
- [ ] Platform connectors use the unified API.
- [ ] AI planning works through the Runtime.
- [ ] Scheduling works reliably.
- [ ] Human approval works.
- [ ] Execution history works.
- [ ] Errors and retries are handled.
- [ ] Security requirements are implemented.
- [ ] Documentation is complete.
- [ ] Migration documentation is available.
- [ ] Test suite passes.
- [ ] Release candidate is validated.

---

## Release requirements

> **Standing rule: after every phase, update GitHub with a release.** A phase is
> not done when the code works — it is done when the release exists.

A phase is **not complete** until all of these exist:

```
Release
├── What's New
├── Features
├── Improvements
├── Bug Fixes
├── Breaking Changes
├── Migration Notes
└── Documentation
```

Plus: implementation, tests, README update, CHANGELOG entry, version bump, git
commit, git tag, GitHub Release. Tags are `vX.Y.Z`, created only from a green CI
run on `main` (ADR-007).

### The gate is enforced, not remembered

```bash
pnpm release:check          # validate the version in package.json
pnpm release:check -- 0.3.0 # validate a specific version
```

Fails **before** a tag exists if the version in `package.json` and
`docs/architecture.md` disagree, the changelog entry is missing or undated,
`[Unreleased]` still holds work, the tree is dirty, the tag already exists,
`HEAD` is already pushed, or a `.env`/`.db` file is tracked. See
[`docs/releasing.md`](docs/releasing.md) for the full procedure.

`v*` tags are protected by a repository ruleset — a published version cannot be
moved or deleted. Publish a new version instead of force-pushing a tag.


## Documentation-first rule

Documentation evolves with the product. Every architectural or user-facing
feature updates its corresponding documentation **in the same phase**. A feature
is not done until `docs/`, the CHANGELOG, and the published docs all reflect
what actually shipped.

---

## Out of scope (by design)

- ❌ Scraping, unofficial APIs, account simulation
- ❌ Bypassing platform posting limits or rate limits
- ❌ Fake engagement / automation against platform ToS

---

## Superseded

The v0.1.0 roadmap (OAuth connectors → AI provider wiring → real dashboard data →
multi-tenant polish) was completed and is preserved in the git history. See
`docs/architecture.md` §3 for what carries forward.

