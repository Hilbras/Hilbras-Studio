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
v0.1.0 — Platform integrations
   │
   ▼
v0.2.0 — Architecture Foundation
   ▼
v0.3.0 — Runtime Foundation
   ▼
v0.4.0 — Multi-Account Connections
   ▼
v0.5.0 — Unified Platform API: targets
   ▼
v0.5.1 — Unified Platform API: connectors
   ▼
v0.6.0 — Goal Engine
   ▼
v0.7.0 — AI Planning
   ▼
v0.8.0  (current) — Human-in-the-Loop
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
- [x] Runtime Engine on the durable queue (ADR-001) — `inngest` v4, served at
      `/api/inngest`.
- [x] Define `Goal`, `Task`, `Run` — migration `0007`: `goals`, `runs`,
      `run_steps`, `run_events`.
- [x] Execution history — `run_events`, append-only.
- [x] Runtime logging — the same table; refusals and retries recorded.
- [x] Error handling and a basic retry mechanism — `ConnectorError.retryable`,
      `shouldRetry`, `MAX_ATTEMPTS`.
- [x] Persist execution state — `src/lib/runtime/service.ts`.
- [x] Plan validation gate (`src/lib/runtime/plan.ts`) and the step executor
      (`executor.ts`).

**Docs:** `architecture.md` ✅, `connectors.md` ✅, `runtime.md` ✅,
`execution.md` ✅, `goals.md` ✅

**Progress: complete → v0.3.0.** A goal's steps are persisted and executed
end to end through the connector contract, with idempotent claiming and
recorded history.

**Carried into later phases:**

- The **scheduler** that turns a goal's cron into events → Phase 4.
- The **planner** that turns a goal into a plan → Phase 5. Until it lands, a run
  executes whatever steps are persisted for it.
- **Approvals** — `awaiting_approval` is modelled and tested, but nothing
  suspends on it yet → Phase 6. *(Shipped in v0.8.0; a run now suspends, and the
  two transitions v0.3.0 guessed were wrong — `reject` and `approval_timeout` now
  resume rather than end the run — are corrected.)*
- **Connector result caches** keyed by idempotency key, so a partial re-run is
  safe → Phase 3. Until then the Runtime declines to re-run a plan whose earlier
  steps already published.
- **Account resolution** through the `accounts` table → Phase 2. Today the
  resolver takes the platform from the account id and the connector reports
  the real connection state, which still means newest-connection-wins.

---

## Phase 2 — Accounts & Connections → **v0.4.0**

Multiple accounts per platform, with a proper connection/account model (ADR-006).

```
X                     LinkedIn
├── @Hilbras          ├── Hassan
├── @HilbrasAI        └── Hilbras
└── @Personal
```

- [x] `Connection` model and `Account` model — migration `0008` (ADR-006).
- [x] OAuth management; secure token storage — `registerConnection()` is the
      single write path; tokens stay AES-256-GCM encrypted.
- [x] Discover available platform accounts — one grant can reach several
      accounts (`accounts` is 1:N from `connections`).
- [x] Multiple accounts per platform; enable/disable; disconnect.
- [x] Account permissions — per-account capability sets, narrower than the
      platform's.
- [x] Handle expired/revoked credentials —
      `listAccountsNeedingAttention()` reports `expired` / `no_token`, distinct
      from `enabled: false`.
- [x] Select specific accounts for Goals — `account_key` (`platform:handle`),
      with `listSelectableAccounts()`.
- [x] Migration + backfill for `social_accounts` and `posts.platforms`.
- [x] Fix the connect callbacks destroying prior accounts — they still write to
      `social_accounts`; see below.

**Docs:** `accounts.md` ✅, `connections.md` ✅, `authentication.md` — deferred,
it documents OAuth flows that are unchanged in v0.4.0 and lands with the v0.5.0
switchover.

**Progress: complete → v0.4.0.** The model exists, is backfilled, and is
covered by nine integration tests.

**Deferred to v0.5.0, deliberately:**

- Switching the OAuth callbacks from `social_accounts` to
  `registerConnection()`, and dropping `social_accounts` and
  `posts.platforms`. Both writers stay live until the release that removes the
  old table, so the v0.1.0 publish path and the v1.0 account model can never
  disagree.
- The Runtime still resolves a connector by the account key's *prefix*
  (`defaultResolver`). `createAccountResolver()` resolves through the accounts
  table and is ready to wire once the callbacks write to it — until then the
  underlying publisher still picks the newest connection.

---

## Phase 3 — Unified Platform API → **v0.5.0**

The Runtime depends on standardized capabilities, never on platform APIs.

Split across two releases, both shipped. v0.5.0 landed the target model the
capability work reads from; v0.5.1 finished the connectors themselves.

Phase 3 continues into v1.0 hardening with the legacy string-bridge removal,
which is a change to the publishing path rather than to the seam above it.

### v0.5.0 — shipped ✅

- [x] Contract `posts.platforms` → `post_targets` (§6 resolution 6) —
      `0011_post_targets_contract`.
- [x] `post_targets.account_key` can address a specific account, and is covered
      by `UNIQUE NULLS NOT DISTINCT (post_id, platform, account_key)`.
- [x] Post + targets written in one transaction — `src/lib/posts/service.ts`.
- [x] `getPostTargets(ids)` — bulk read replacing four `split(",")` sites.

### v0.5.1 — shipped ✅

- [x] Capability interface: `create_post`, `publish_post`, `get_posts`,
      `get_account`, `delete_post` — real sets replace
      `status: "supported" | "connect_only"`.
- [x] `src/lib/connectors/registry.ts` — `lookupCapability()` as the single
      gate, returning a *reason* rather than a null.
- [x] Adapters derive capabilities from the registry; drift is a test failure.
- [x] Capability discovery: `capabilitiesForPlatform()`, `platformSupports()`,
      `knownPlatforms()`, `publishingPlatforms()`.
- [x] Wire `resolverForUser()` into the Inngest function — production execution
      resolves through the accounts table (deferred from v0.4.0). **A disabled
      account no longer publishes.**
- [x] The capability gate reads the registry, not the adapter's self-declaration.
- [x] Connector development standards: `docs/capabilities.md`,
      `docs/platform-development.md`, `docs/connectors.md`.

### Still open

- [ ] Retire `legacy.ts`'s string-based error classification. This means
      rewriting the five publishers in `@/lib/publish` to report their own
      taxonomy — a change to the publishing path, not the seam above it.
      → v1.0 hardening.
- [ ] Implement `get_posts` and `delete_post`. Declared, implemented by nobody.
- [ ] Split `legacy.ts` into per-platform connector directories.
- [ ] `PUBLISHING_CAPABILITIES` and `accounts.capabilities` are maintained by
      hand; capability resolution per account type (a Facebook Page vs. a
      profile) is not yet derived from the platform's account model.

**Docs:** `connectors.md` ✅, `capabilities.md` ✅, `platform-development.md` ✅

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

- [x] Goal creation, parsing, validation, configuration.
- [x] Scheduling and constraints.
- [x] Target accounts.
- [x] Goal status, history, editing, pause/resume.

**Docs:** `goals.md`, `scheduling.md`, `goal-engine.md`

### v0.6.0 — shipped ✅

The Runtime was complete and dark: `executeGoalRun` waited for a `GOAL_SCHEDULED`
event that nothing sent, and no way existed to create, edit, or stop a goal. This
phase made a schedule mean something.

- **Cron engine** (`src/lib/goals/cron.ts`) — five fields, macros, Vixie's
  OR-the-two-day-fields rule, and DST-correct next-firing arithmetic. A schedule is
  a local wall-clock promise: a skipped hour is skipped, a repeated hour fires
  **once**. No new dependency.
- **Validation gate** (`validation.ts`) — pure, so the whole gate is testable
  without Postgres. Refuses the roadmap's own example, because LinkedIn has no
  publisher: a goal saved there would look configured and never publish. Collects
  every issue, not the first.
- **Interval floor** — two firings no closer than 15 minutes, enforced by probing
  real consecutive slots. A goal publishes on every firing, so this is the floor
  on how often the product can post for a user.
- **Prefill** (`parse.ts`) — reads platforms, cadence, and time out of the
  sentence the user is writing anyway. Never invents an account key, never
  proposes a schedule its own validator would reject, and says what it did *not*
  read.
- **Service** (`service.ts`) — the only writer of `goals`. Edits re-validate the
  whole goal; a refused edit changes nothing; pausing clears the firing time.
- **Scheduler** (`scheduler.ts` + an Inngest cron function) — **advance, then
  dispatch**, and compute the next slot from *now* so missed firings collapse into
  one run rather than arriving as a burst.
- **Migration 0012** — `next_firing_at timestamptz` + a partial index, with a
  backfill for goals that predate the column.
- **Defect fixed** — a run with no steps reported `completed`. Nothing has ever
  written `run_steps`, so a fired goal did nothing and claimed success. It now
  fails with `run.no_steps`.

**Not here, on purpose:** the Goals UI (Phase 7), natural-language planning
(Phase 5), and a per-goal catch-up queue.

---

## Phase 5 — AI Planning → **v0.7.0**

```
Goal → AI Planner → Execution Plan → Runtime
```

Example plan: research topics → generate ideas → generate posts → validate →
publish → verify → report.

- [x] AI Planner and tool selection.
- [x] Generate and validate execution plans.
- [x] Execute plans through the Runtime.
- [x] Re-planning; context management; execution limits.
- [x] Handle AI failures; prevent unauthorized tool usage.
- [x] Per-run and per-step AI spend limits.

**Docs:** `ai/planner.md`, `ai/tools.md`, `ai/context.md`, `runtime/planning.md`

### v0.7.0 — shipped ✅

A goal fired, and did nothing. The Runtime was fully built and had never once
written a `run_steps` row, so every firing was a no-op reporting success. This
phase is where a plan comes from — and it is the first release in which a model's
output causes something to happen in the world.

- **Tool registry** (`src/lib/runtime/tools.ts`) — the central new abstraction. A
  tool is what a *step* may invoke, not what a platform can do. Two tools ship:
  `compose_post` and `publish_post`. The registry is the offerable set, so which
  capabilities exist is one answer in one file rather than a prompt instruction.
- **Planner** (`src/lib/ai/planner.ts`, `context.ts`) — reads the statement,
  proposes, parses, repairs once. Treated as untrusted from the first token.
- **Gate, narrowed** (`plan.ts`) — checks the plan against **the goal's
  targets**, and requires every one of them to receive a delivery. A goal
  pointed at two accounts that posts to one now fails rather than looking like it
  worked.
- **Preflight** (`runtime/planning.ts`) — every target connected, enabled, and
  deliverable, checked *before* the model. An unusable target costs zero calls.
- **Step references** (`references.ts`) — explicit `{"$ref": {"step": 0,
  "field": "text"}}`, stored unresolved so a plan is self-describing and a replay
  reproduces its inputs.
- **Execution** (`executor.ts`, `local-tools.ts`) — `getTool` dispatch,
  dependency gating, `$ref` resolution, and a Runtime-owned tool runner.
- **Spend** (`ai/limits.ts`, `ai/complete.ts`) — one model-call boundary, metering
  the run first, then the window, then resolving the provider. A refused call
  never eats the user's other AI budget.
- **No migration** — `runs.plan`, `run_steps`, and the unique `idempotencyKey`
  all already existed.

**The decisions that shaped it:**

- **Tools ≠ capabilities.** `CAPABILITY_NAMES` is what a *platform* can do; a
  tool is what a *step* may invoke, either delegating to a capability
  (`publish_post`) or run by the Runtime itself (`compose_post`). The namespaces
  overlap and are not equal. `run_steps.capability` now holds a tool name; the
  column kept its name because the concept predates the tool layer.
- **A step never names a platform.** Its destination is an *account*, resolved
  through the connector registry at execution. A test asserts the exact key set
  of every `ToolSpec`, so the field cannot be added quietly.
- **The gate is checked against the goal's targets, not the user's accounts.**
  `requiredTargets` both narrows the gate's own lookup and requires every target
  to receive a delivery. A convention nobody is forced to follow is not a gate.
- **The planner is a repair loop, not a retry loop.** One repair, with the gate's
  own issue text verbatim, before any step runs. No re-planning after a failure
  — a planner shown a failure is being invited to remove the thing that failed.
- **A malformed reply is a failed plan, not a shorter one.** Dropping a bad step
  is how a two-account plan posts to one and reports success.
- **Copy is written at execution, not planning time.** Hence `compose_post` as a
  step: a goal firing daily must not publish the same words daily.
- **Over-limit copy fails, never truncates.** One re-ask, then a non-retryable
  `invalid_content`. Truncated ends mid-sentence and looks like a bad post.
- **Per-run and per-step spend are in-process counters, not rate limits.** The
  window budget is keyed by user; a per-run budget must not leak between a
  user's concurrent goals. `perPlan 2, perStep 2, perRun 12`.
- **The run's meter is a ceiling, not a ledger.** A redelivery rebuilds it, so the
  true bound is `MAX_ATTEMPTS × perRun`. Documented as a known bound.
- **Preflight before the model.** A planner cannot fix a disconnected account, so
  an unreachable target costs zero model calls.
- **Model calls are retryable; publishes are not** (ADR-005, both defaults
  correct for opposite reasons).

**Not here, on purpose:** human approval of a plan (Phase 6), the Goals UI
(Phase 7), and re-planning after a mid-run failure — see the note above on why
the retry path does not include it.

---

## Phase 6 — Human-in-the-Loop → **v0.8.0**

The Runtime pauses and requests approval for sensitive or configurable actions.

```
AI → Generate Post → Approval Required → User → Approve → Runtime → Publish
```

- [x] Approval system; pending actions.
- [x] Approve, reject, edit-before-approval.
- [x] Approval timeout.
- [x] Execution policies; per-tool and per-account approval settings.
- [x] Action permissions.

```
Publishing:  [ Auto ]  [ Approval Required ]  [ Disabled ]
```

> Durable suspension across hours or days comes from the queue (ADR-001) — this is
> why the managed queue was chosen.

### v0.8.0 — shipped ✅

A plan could publish, and nothing in the product could stop it. `awaiting_approval`
had been modelled and unit-tested since v0.3.0 and nothing ever suspended on it,
so the one state that says *a person should look at this* was a state the Runtime
could reach only by hand. This phase is where a person gets a vote.

**Docs:** [`docs/runtime/approvals.md`](docs/runtime/approvals.md),
[`docs/runtime/permissions.md`](docs/runtime/permissions.md),
[`docs/runtime/policies.md`](docs/runtime/policies.md)

### What it cost, and what it changed

**Service only — no interface.** Phase 7 owns the screens. v0.8.0 ships the
system, so a policy set programmatically takes effect immediately, and a
suspended run is already in the database waiting for a decision that today
arrives through code rather than a button.

**`ToolSpec.sideEffect` is the discriminator**, and it is a declared field rather
than `capability !== null`: a future read-only connector tool delegates to a
platform and has no side effect, and the derived version would put a question in
front of a step that cannot publish anything. Only `publish_post.text` is
editable — `mediaUrl` is a new capability being granted, not an edit.

**An edit is validated by the plan gate's own `validateToolInput`**, now exported
and shared, because a human at the approval screen is a *later* stage than the
gate and a weaker check there would make the one place a person reads the content
the one place it is unchecked.

**A timeout fails, it never approves.** Publishing because the user was asleep is
the opposite of what "require approval" asked for.

**All three decisions resume the run to `running`.** v0.3.0 shipped
`reject → cancelled` and `approval_timeout → failed`, which made a human decision
about *one step* decide the fate of *every other step*. Corrected in v0.8.0; the
difference is recorded on the step, and `cancel` remains the one decision that
ends a run.

**A suspension is a return, not a throw** — and it lives in Postgres, not in the
queue, so a decision that never reaches the queue is recovered by a five-minute
sweep rather than needing an outbox. See ADR-001 for why that shape was chosen
over `step.waitFor`.

---

## Phase 7 — Studio UI 2.0 → **v0.9.0**

Redesign Studio around the Runtime instead of around integrations.

- [x] Runtime dashboard (status, running goals).
- [x] Goals dashboard and creation/configuration UI.
- [x] Account and connection management.
- [x] Execution history and runtime logs.
- [x] Approval interface and runtime controls.
- [x] Error management; usage metrics.

**Docs:** user guide under `src/app/docs/*`

### v0.9.0 — shipped ✅

The Runtime has been complete since v0.8.0 and none of it was visible. Every
capability — goals, plans, runs, approvals, policies — had a service function and
no screen, so a user setting an `approval` policy had no way to answer the
question it created. This phase is the interface, and the interesting part of it
is the read layer the interface needed.

**The Runtime dashboard is the new home.** `/dashboard` permanently redirects to
`/runtime`. The integration pages are kept, not deleted, and demoted to a *Quick
tools* group — they still work, and removing a working screen to make a redesign
look decisive would be a worse outcome than a slightly busier sidebar.

**`runtime/queries.ts` is the only module UI code may read user data through.**
`runtime/service.ts` has readers that are deliberately unscoped — `getRun`,
`listRunSteps`, `listRunEvents` — because the executor and the resume path are
handed a `runId` by the queue and cannot ask whose run it is. They are the right
functions for the Runtime and the wrong ones for a page: a run row contains the
plan, and the steps contain the *resolved* input, so a screen that renders what it
gets shows one tenant's drafts to another. Every function in `queries.ts` takes a
`userId` and puts it in the `WHERE` clause, not in a filter applied afterwards. A
known id belonging to someone else is `null` rather than an error, because an
error would confirm the row exists. See ADR-008.

**`runtime/view.ts` is pure, and that is why it can be shared.** State to label,
tone, and meaning, with no fetch and no formatting of user text, so the
dashboard, the run log, and the approval screen cannot drift apart on what a
status *is*. The tables are `Record<ExecutionState, StatusMeta>` and friends, so
adding a state without deciding what it means is a `typecheck` failure rather than
a bare badge in one place. `approvalDeadlineView` calls the server's own
`isOverdue` instead of re-deriving the comparison, so the countdown and the
decision cannot disagree about the boundary.

**`GOAL_STATUSES` moved to `goals/validation.ts`** and is re-exported from
`goals/service.ts`. A client component needs the vocabulary to label a goal, and
vocabulary is not a secret; behind a `server-only` import, copying the list would
have been the only way out.

**Two reads that could have lied, and do not.** The pending question on a run is
read from the *approval row*, not from `run.state` — the approval is settled
before the resume transitions the run, so a page reading the state alone renders a
question that has already been answered. And "overdue" uses `expires_at <= now`,
the exact negation of `isOverdue`, so it counts what is *about* to fail rather than
only what already has: the sweeper may be five minutes from marking an approval
expired, and `overdue: 0` across four lapsed questions is the cheerful lie the
count exists to prevent.

**The client never decides state.** The approval card renders the action's return
value verbatim, including every validation issue, and has no optimistic transition
and no local copy. If the server refuses an edit, the screen says so with the rule
that refused it. The editable fields are derived from `editableFields(getTool(...))`
rather than hardcoded, so the screen cannot offer a field the tool would not
accept.

**Waking the queue is best-effort, and the swallowing is the design.** The
decision is durably written before the event is sent, so a send that fails leaves
the system correct and merely slow — the sweeper re-sends within five minutes.
Reporting it would tell a user their approval failed when it was in fact recorded,
and they would press Approve again and be told `already_decided`. Without the call
the delay is not an edge case, it is every approval.

**Pages moved, and the errors moved with them.** `/accounts` is now connected
account management; the credentials form moved to `/settings/credentials`, and the
OAuth failure redirects and the `safeReturnPath` fallback were repointed to match,
so a failed connect lands on the page where the fix is. Policies live at
`/settings/policies`, and list only what `describePolicyTargets` may name — a
control for `compose_post` would be a switch that does nothing.

**Recent-N paging, capped.** Run lists and the event log page by `clampLimit(...)`,
so a `?limit=` in a URL cannot ask for the whole table. A history too long for one
page is a reason to build pagination, not to let a request size itself.

**A goal that cannot act is counted.** If a goal targets an account that is
switched off or can no longer publish, nothing errors and no run is ever created —
the goal simply goes quiet, forever. The dashboard counts those goals explicitly,
because it is the one Runtime problem that never appears in the run history.

**Enforced.** `scripts/mutate-phase7.sh` — 16 mutations, 0 holes. Each removes the
`userId` from a different `WHERE` clause, inverts a state predicate, drops the
limit cap, or re-derives the deadline comparison, and requires the integration
suite to fail. Three are expected to break `typecheck` and `build` rather than a
test, which is the `server-only` import boundary ADR-004 predicted would be
mechanically checkable.

**One pre-existing bug found and fixed.** `tests/integration/goals.test.ts`
asserted a hardcoded `nextFiringAt`, and `updateGoal` recomputes from the wall
clock. The test therefore only passed between midnight and 06:30 Berlin each day
— one afternoon away from breaking CI. It now asserts the property the
recomputation exists to provide — the stored time is 06:30 in the schedule's own
timezone, and in the future — rather than a date, which also makes it correct
across a daylight-saving boundary.

**Also in this release:** the `wakeRun` rule moved out of a private function in a
`"use server"` module into `src/lib/runtime/inngest/wake.ts`, following ADR-004's
own reasoning. As written it could only be tested by standing up a session, a form
post, and a database to assert that a thrown error is *not* propagated — a test
expensive enough that it would not have got written.

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

