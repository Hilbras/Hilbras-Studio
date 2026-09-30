# Hilbras Studio — Architecture

**Status:** Living document. Updated in the same phase as the code it describes.
**Current version:** v0.10.0
**Target version:** v1.0.0 — Goal-Driven AI Runtime

This document defines the architectural layers, the boundaries between them, and
the decisions (ADRs) that constrain them. For the phase-by-phase delivery plan see
[`../ROADMAP.md`](../ROADMAP.md).

---

## 1. Product definition

Hilbras Studio is a **Goal-Driven AI Runtime**. It receives goals, and plans and
executes them using AI, tools, platform connections, accounts, schedules, and
human approvals.

> "Every day at 10 AM, publish two AI-related posts on the Hilbras X and LinkedIn
> accounts."

This replaces the v0.1.0 definition — "a tool that connects AI with different
platforms" — which described the *mechanism*. The Runtime describes the *product*.

The user-facing flow at v1.0:

```
Create Goal → Select Accounts → Set Schedule → Runtime → AI Planning
  → Execution → Approval (if required) → Monitoring → Result
```

---

## 2. Layer map

```
┌──────────────────────────────────────────────────────────┐
│  Studio UI          src/app/**, src/components/**         │  presentation
└───────────────────────────┬───────────────────────────────┘
                            │ server actions / route handlers
┌───────────────────────────▼───────────────────────────────┐
│  Interface          src/app/actions/**, src/app/api/**    │  browser boundary
└───────────────────────────┬───────────────────────────────┘
                            │ thin: auth + validation only
┌───────────────────────────▼───────────────────────────────┐
│  Services / Domain   src/lib/**                           │
│  ┌────────────┬─────────────┬────────────┬──────────────┐ │
│  │  Runtime   │  Accounts   │    AI      │    Tools     │ │
│  │ Goal/Run/  │ & Connec-   │  Layer     │  (capability │ │
│  │ Step       │  tions      │            │   wrappers)  │ │
│  └────────────┴─────────────┴────────────┴──────────────┘ │
│  ┌──────────────────────────────────────────────────────┐│
│  │  Connectors      src/lib/connectors/**               ││
│  │  the ONLY code that knows a platform's API shape     ││
│  └──────────────────────────────────────────────────────┘│
└───────────────────────────┬───────────────────────────────┘
                            │ Drizzle queries only
┌───────────────────────────▼───────────────────────────────┐
│  Infrastructure   src/db/**, src/proxy.ts, queue client  │
└──────────────────────────────────────────────────────────┘
```

### 2.1 Layer contracts

Each rule below is a **hard boundary**. Violating one is a review blocker, not a
style preference.

---

#### Studio UI

- **Owns:** rendering, client state, optimistic display, forms, navigation.
- **Must not:** import `server-only` modules, touch Drizzle, hold secrets, or
  assert terminal execution state. A client may *display* a result the server
  produced; it may never claim one happened.
- **Location:** `src/app/**` (pages), `src/components/**`.

#### Interface (server actions & route handlers)

- **Owns:** authentication, authorization, input validation, and nothing else.
- **Must not:** contain business rules, orchestrate multi-step work, or call
  external APIs directly. It delegates to a server-only service immediately.
- **Location:** `src/app/actions/**`, `src/app/api/**`.

> This boundary already exists and is already load-bearing: the credential
> writer was moved out of the (now-deleted) `actions/credentials.ts` into the
> server-only `src/lib/credential-store.ts` so the browser-callable module
> cannot be used as a privileged path. The writer is still there, reached now
> through `actions/platform.ts`. Keep that pattern.

#### Services / Domain

- **Owns:** all business rules, invariants, and state transitions.
- **Must:** be marked `import "server-only"` (18 modules already are).
- **Must not:** be imported by client components.
- **Location:** `src/lib/**` (becomes sub-packages in v1.0).

#### Connectors *(interface in Phase 1, standardised in Phase 3)*

- **Owns:** translating a **capability** call into a platform API call, and
  translating the platform's response/error back into the standard shape.
- **Must not:** leak platform-specific types, error strings, or auth flows above
  this layer. The Runtime must never see a Facebook Graph error code.
- **Must not:** grant itself a capability. `PUBLISHING_CAPABILITIES` in
  `platforms.ts` is the authority, and `lookupCapability()` reads the registry
  rather than an adapter's own list — an adapter is the module that performs the
  publishing, so it must not also decide whether it is allowed to.
- **Location:** `src/lib/connectors/`. `registry.ts` is the seam; the per-platform
  split into `src/lib/connectors/<platform>/` is still to come, and is tracked in
  [`../ROADMAP.md`](../ROADMAP.md).

#### Accounts & Connections *(Phase 2)*

- **Owns:** OAuth flows, token lifecycle, refresh, revocation, and the
  `Connection -> Account` model.
- **Key invariant:** a **Connection** is an authorization grant; an **Account**
  is an identity on a platform reachable through it. One connection may yield
  many accounts. The current schema conflates these -- see section 4.2.
- **Location:** `src/lib/accounts/**`, `src/lib/platform-tokens.ts` (today).

#### AI Layer

- **Owns:** provider configuration, model selection, request shaping, and
  **spend enforcement**.
- **Must not:** be callable without passing through `ai-budget.ts`. Every model
  entry point -- Assistant, Composer, inbox suggestions, provider pings,
  summaries, memory extraction -- is already budgeted. New entry points inherit
  this requirement.
- **Location:** `src/lib/ai.ts`, `ai-sdk.ts`, `ai-budget.ts`, `chat.ts`, and
  `src/lib/ai/**` (the planner, the `compose_post` tool, the per-run meter, and
  the single model-call boundary).

#### Tools *(Phase 5, v0.7.0)*

- **Owns:** the set of things a *step* in a plan may invoke, as typed
  declarations with named input fields.
- **Must not:** name a platform, or bypass the Connectors layer.
- **Location:** `src/lib/runtime/tools.ts`, `src/lib/runtime/local-tools.ts`.

**A tool is not a capability.** A capability is what a *platform* can do, owned by
`platforms.ts` and gated by the target account. A tool is what a *step* may
invoke: either delegating to a capability (`publish_post`) or run by the Runtime
itself with no platform involved (`compose_post`). The namespaces overlap and are
not equal -- `get_account` is a capability with no step behind it, and the gate
refuses it by name. `run_steps.capability` now holds a tool name; the column
keeps its original name because the concept predates the tool layer.

There is deliberately **no platform field on a tool**. A step's destination is an
*account*, resolved through the connector registry at execution time, which is
what lets one plan run against different platforms and lets an unsupported
target be caught at plan validation rather than mid-publish. A test asserts the
exact key set of every `ToolSpec` so the field cannot be added quietly.

The registry is also the *offerable* set: the planner is shown these tools and
the gate accepts these tools, so "which capabilities exist" is one answer in one
file rather than a prompt instruction the model can be talked out of. See
[`ai/tools.md`](./ai/tools.md).

#### Runtime *(Phase 1, goal engine in Phase 4, planning in Phase 5, approvals in Phase 6)*

- **Owns:** Goal -> Plan -> Run -> Step -> Result, execution state, retries,
  scheduling, and approval suspension.
- **Must not:** contain platform-specific logic, and must never talk to a
  platform API directly -- only through Connectors.
- **Location:** `src/lib/runtime/**`, `src/lib/runtime/inngest/**` (Inngest),
  `src/lib/goals/**`.

Since v0.8.0 the Runtime also owns **what the user permits it to do unattended**,
and the permission gate is a required dependency of the executor rather than
something the executor reaches for. A permissive default would mean forgotten
wiring publishes unattended with nothing at the call site saying so, so
`ExecutorDeps.approval` has no default and the v0.7.0 `defaultDeps` object is
deleted. See [`runtime/permissions.md`](./runtime/permissions.md) and
[`runtime/policies.md`](./runtime/policies.md).

The goal engine (`src/lib/goals/**`) sits under the Runtime rather than beside it:
it is the only producer of `GOAL_SCHEDULED` events and the only writer of
`goals`. It depends on the Runtime's run store, never the reverse.

Four gates validate overlapping properties at four different times, and
**none replaces the others**. `lib/goals/validation.ts` checks a goal when a user
saves it, so a goal against a disconnected or incapable account is refused while
someone is still looking at the form. `lib/runtime/planning.ts` re-checks the
same accounts at firing time, before spending a model call -- a goal validated
today can have its account disconnected tomorrow. `lib/runtime/plan.ts` checks
the plan itself, because a planner's output is untrusted by construction, and
checks it against **the goal's targets**, not the user's account list.

The fourth, `lib/runtime/approval-store.ts`, is the only one that reads an
execution policy, and it is deliberately the last: it runs immediately before a
dispatch, because a policy can change between a plan being written and a step
being executed, so the reading that governs whether something happens has to be
the one immediately before it happens.

#### Two modules the UI is allowed to use, and why there are only two

The Runtime module holds two kinds of reader, and v0.9.0 made that split explicit
because a screen had to be able to tell them apart.

`runtime/service.ts` has readers that are **deliberately unscoped** — `getRun`,
`listRunSteps`, `listRunEvents`. They take a `runId` and nothing else, because
the executor and the resume path are handed a run id by the queue and cannot ask
whose run it is. Removing the scope would mean an ownership lookup on every step
of every run, on the hot path, to answer a question those callers do not have.

Those are the right functions for the Runtime and the wrong ones for a page.
`getRun` answers "does this run exist", and a screen that renders what it gets
will show one tenant's plan, step input, and drafts to another. So:

- **`runtime/queries.ts` (`server-only`)** — every function takes a `userId` and
  puts it in the `WHERE` clause, not in a filter applied afterwards, so a row
  that is not the caller's never exists in memory to be rendered by mistake. This
  is the **only** module UI code may read user data through. Run ids are
  `randomUUID`, so the unscoped readers are not *practically* guessable — but
  "not practical" is not a property a tenancy boundary should rest on.
- **`runtime/view.ts` (pure)** — state to label, tone, and meaning. No fetch, no
  formatting of user text, no decision about what a screen should show. It is
  separate from the read layer so the same vocabulary is reusable by the
  dashboard, the run log, and the approval screen without three copies of the
  labels drifting apart. Being pure is also what lets a client component import
  it: it sits on the same side of the `server-only` line as the component.

See [ADR-008](#adr-008--a-page-reads-user-data-only-through-an-owner-scoped-read-layer).

`view.ts` also moved `GOAL_STATUSES` into `goals/validation.ts`, which is pure,
and re-exported it from `goals/service.ts`. A client component that wants to
label a goal needs the vocabulary, and vocabulary is not a secret; leaving it
behind a `server-only` import would have made copying the list the only way out.

#### Infrastructure

- **Owns:** Postgres access, session cookies, outbound HTTP policy, and the
  durable queue client.
- **Location:** `src/db/**`, `src/proxy.ts`, `src/lib/pinned-provider-fetch.ts`.

---

### 2.2 Dependency rules

Dependencies point **downward only**. Never upward, never sideways across a
boundary.

| May import | Must not import |
|---|---|
| UI | anything `server-only`, `src/db/**` |
| Interface | client components |
| Services | UI, Interface |
| Connectors | Runtime, Tools, UI |
| Runtime | Connectors' *interfaces* -- never their platform internals |
| Infrastructure | everything above it |

The single most important rule: **the Runtime depends on the Connector
*interface*, not on any platform.** This is what makes Phase 3 additive instead
of a rewrite, and it is why the interface is defined in Phase 1 (see ADR-002).

                            │ server actions / route handlers
┌───────────────────────────▼───────────────────────────────┐
│  Interface          src/app/actions/**, src/app/api/**    │  browser boundary
└───────────────────────────┬───────────────────────────────┘
                            │ thin: auth + validation only
┌───────────────────────────▼───────────────────────────────┐
│  Services / Domain   src/lib/**                           │
│  ┌────────────┬─────────────┬────────────┬──────────────┐ │
│  │  Runtime   │  Accounts   │    AI      │    Tools     │ │
│  │ Goal/Run/  │ & Connec-   │  Layer     │  (capability │ │
│  │ Step       │  tions      │            │   wrappers)  │ │
│  └────────────┴─────────────┴────────────┴──────────────┘ │
│  ┌──────────────────────────────────────────────────────┐│
│  │  Connectors      src/lib/connectors/**               ││
│  │  the ONLY code that knows a platform's API shape     ││
│  └──────────────────────────────────────────────────────┘│
└───────────────────────────┬───────────────────────────────┘
                            │ Drizzle queries only
┌───────────────────────────▼───────────────────────────────┐

---

## 3. Current inventory (v0.1.0) — keep / refactor / retire

A review of the 113 files under `src/` and 18k lines of TypeScript. This is the
input to Phase 0's first task: *identify existing functionality that should
remain*.

### 3.1 Keep as-is

These are finished, tested, and load the layers above them. Do not rewrite.

| Asset | Why it stays |
|---|---|
| `src/db/schema.ts` + 7 migrations | Postgres/Drizzle foundation. Table-per-aggregate style is already correct. |
| `src/lib/session.ts`, `src/proxy.ts` | Versioned JWT sessions, sliding refresh, revocation via `token_version`, in-memory auth throttle. Correct and complete. |
| `src/lib/crypto.ts` | AES-256-GCM secret encryption. The basis for all credential storage. |
| `src/lib/credential-store.ts` | Server-only, user-scoped credential writer. The reference implementation of the Interface -> Services boundary. |
| `src/lib/net-guard.ts`, `pinned-provider-fetch.ts` | DNS-pinned, SSRF-hardened outbound HTTP. Every new external call must use this. |
| `src/lib/ai-budget.ts`, `rate-limit.ts` | Per-user and deployment-wide spend limits. Extend; never bypass. |
| `src/lib/ai-limits.ts` | Platform content constraints the AI must respect. Feeds Connector capability metadata. |
| `src/lib/schedule.ts` | Strict local schedule parsing. Becomes the Goal scheduler's input validator. |
| `src/lib/platforms.ts` | Platform registry + `PUBLISHING_CAPABILITIES`. The seed of the Connector capability model. |
| `src/lib/threads-errors.ts`, `credential-status.ts`, `media-sniff.ts` | Focused, tested utilities. |
| `src/components/ui/**`, `src/components/motion/**` | Design system. Studio 2.0 restyles, does not replace. |
| Vitest + CI + Testcontainers | 42 unit + 14 integration tests, full quality gate in `.github/workflows/ci.yml`. The safety net every later phase depends on. |

### 3.2 Refactor

| Asset | Problem | Target phase |
|---|---|---|
| `social_accounts` table | Conflates Connection and Account. No unique constraint on `(user_id, platform, platform_account_id)`, so reconnects append duplicate rows. `posts.platforms` is a comma-separated string, which cannot express per-account targeting. | **Done** — split in v0.4.0, both legacy tables dropped in v0.5.0 |
| `getConnectedAccount()` (`publish.ts:138`) | `.orderBy(connectedAt desc).limit(1)` -- publishing always targets the **most recently connected** account. Multi-account is structurally possible but not implemented. | Phase 2 |
| `publish.ts` (926 lines) | Five unconnected `publishToX()` functions, no shared interface, inconsistent error shapes. The single highest-value refactor in the roadmap. | Phase 1 (wrap) -> Phase 3 (standardize) |
| `PUBLISHING_CAPABILITIES` | `status: "supported" \| "connect_only"` is a boolean wearing a type. Cannot express `get_posts`, `delete_post`, or per-account capability sets. | **Done** in v0.5.1 — real capability sets, registry as authority |
| `scheduled-posts.ts` | Claim/lease logic is correct and proven, but is bound to the `posts` table and a daily Vercel cron. Generalize into the Runtime. | Phase 1 |
| `actions/*.ts` (13 files) | Some still mix validation with orchestration. Thin them per section 2.1. | Phases 1-4 |
| `src/app/docs/*` (7 pages) | Public in-app user guide. Distinct from `docs/*.md`, which are developer docs. Reconcile explicitly. | Phase 0 (this doc) |

### 3.3 Retire

| Asset | Reason |
|---|---|
| `src/lib/mock-data.ts` | **Done 2026-09-29** — deleted with zero importers. |
| `vercel.json` cron entry | Replaced by the durable queue (ADR-001). Kept only as a fallback sweep. |
| `data/hilbras.db` | SQLite artifacts. The app is Postgres-only. Not tracked by git; delete locally. |
| `app/actions/dashboard.ts`, `actions/analytics.ts` | **Done 2026-09-30** — thin adapters whose last caller became a server component reading `dashboard/queries.ts` directly. See ADR-008. |
| `app/actions/credentials.ts` | **Done 2026-09-30** — generic-credential UI superseded by the per-platform path in `actions/platform.ts`. The writer in `lib/credential-store.ts` is still live. |

---

## 4. Target architecture (v1.0)

### 4.1 Runtime data model

```
Goal ──1:N──> Run ──1:N──> Step ──N:1──> Account
 │             │            │      │
 │             │            │      └── enabled, capabilities
 │             │            ├── tool invocation (capability + args + result)
 │             │            ├── 0..1 Approval  (the resolved input, a decision, a deadline)
 │             │            └── execution state, attempt count, idempotency key
 │             └── execution state, attempt count, idempotency key
 ├── ExecutionPolicy  (per account, per tool: auto | approval | disabled)
 └── schedule, constraints, target accounts
```

Execution states: `pending -> running -> (completed | failed | cancelled)`,
plus `awaiting_approval` as a **suspension**, not a terminal state. A suspended
run holds no lease and consumes no budget.

**An Approval holds the *resolved* input, not the plan's.** A `publish_post`
step normally carries `{"$ref": {"step": 0, "field": "text"}}`, and a person
cannot be asked to approve a reference -- so the snapshot is taken after
reference resolution and is what gets published on approval. `UNIQUE (step_id)`:
a step executes once, so it can be asked once. `expires_at` is `timestamptz`
because it is compared against `now()` in a query, the same rule as
`next_firing_at`.

**v0.8.0 changed two transitions.** `reject` and `approval_timeout` used to lead
to `cancelled` and `failed`; both now resume the run to `running`, because a
human's "no" to one step says nothing about its siblings, and the
settle-independently rule already governs every other step failure. `cancel`
remains the one decision that ends a run. See
[`runtime/approvals.md`](./runtime/approvals.md#why-a-decision-resumes-the-run).

A goal additionally carries `next_firing_at`: a **derived** instant the scheduler
selects on, so finding what is due is one index scan rather than a cron evaluation
per active goal. `schedule_cron` and `schedule_timezone` remain the source of
truth, and every mutation that changes either recomputes it. It is `timestamptz`
because it denotes an absolute moment; every other timestamp in this schema is a
bare `timestamp` and is read in the session's `TimeZone`.

### 4.2 Connection vs. Account

The v0.1.0 conflation is the schema change that most constrains v1.0.

```
Connection  (one OAuth grant / bot token)
    │
    ├──> Account  "x:hilbras"        enabled, capabilities: [publish, read]
    ├──> Account  "x:hilbrasai"      enabled, capabilities: [publish, read]
    └──> Account  "x:personal"       disabled
```

A Goal targets **Accounts**, never Connections. Capabilities are resolved
per account, because a disabled account or a degraded token must not silently
remove a target from a plan.

### 4.3 Execution flow

```
Goal fires
  -> Runtime creates Run (idempotency key = goal + schedule slot)     v0.6.0
  -> Preflight: every target connected, enabled, deliverable          v0.7.0
       -> refuse with no model call spent
  -> AI Planner produces a Plan: ordered Steps with $ref inputs       v0.7.0
  -> Plan gated against the goal's accounts + the tool registry       v0.7.0
       -> one repair with the gate's own issue text, then stop
  -> Steps execute through Tools -> Connectors                       v0.1.0
  -> Each step is claimed: a compare-and-swap on its state           v0.8.0
  -> $refs resolved, then Side-effecting steps check the policy       v0.8.0
       -> auto        : proceed
       -> approval    : suspend Run, return normally, no retry
       -> disabled    : fail the Step with a policy error, no question asked
  -> Suspension lifted by a decision, or by the 24h window closing     v0.8.0
       -> approve     : execute with the *approved* input
       -> reject      : fail the Step, continue to its siblings
       -> timeout     : fail the Step, continue to its siblings
  -> Verify step confirms the real platform state                    v1.0
  -> Report generated                                                v1.0
```

A suspension is a **return, not a throw**. The invocation that hits the gate
completes normally, having done everything it can; asking the queue for another
attempt would arrive at the same question, and asking twice is not a way of asking
better. The run lives in Postgres rather than in the queue until an
`APPROVAL_DECIDED` event wakes a separate `resume-goal-run` function, which picks
up from the step that was waiting. See
[`runtime/approvals.md`](./runtime/approvals.md).

**Copy is written at execution, not at planning time.** A plan says *what* each
post should argue; a `compose_post` step writes the words when the step runs. A
goal firing daily must not publish the same words daily, and a plan is a record
of what was decided — it should not be the place where the content is frozen.

**Server-authoritative state (ADR-003).** Every transition above is computed and
persisted server-side. Clients render it. This is already the rule for publish
results and it extends to all execution state.

---

## 5. Architecture Decision Records

### ADR-001 — Durable execution uses a managed queue (Inngest)

**Status:** Accepted · Phase 0

**Context.** Execution today is a request-triggered loop
(`scheduled-posts.ts`) invoked by a Vercel cron configured at `0 9 * * *` --
**once per day**, a Hobby-plan limit the README already flags. A v1.0 goal of
*"every day at 10 AM"* needs minute-level scheduling, and a Phase 5 plan is a
multi-step chain (research -> generate -> validate -> publish -> verify) that
outlives a 120s function timeout and must survive a crash mid-plan.

**Options considered.**

1. *Managed queue (Inngest / Trigger.dev)* -- durable steps, retries, cron,
   no infra to operate, keeps the Vercel deployment.
2. *Self-hosted worker* polling Postgres -- extends the existing claim/lease
   pattern, maximum control, but new infra and on-call burden.
3. *Stay on Vercel Cron* -- cheapest, but caps sub-daily scheduling, long plans,
   and crash recovery at the product level.

**Decision.** Option 1, with **Inngest** specifically.

**Why Inngest over the alternatives.** Phase 6 (Human-in-the-Loop) is the
deciding constraint: an approval that waits hours or days for a human is a
first-class primitive rather than a state machine hand-rolled on a queue. Phase 1's
Plan -> Step model maps 1:1 onto Inngest steps. Phase 5 re-planning and Phase 8
crash recovery, retries, and idempotency are platform-provided rather than
hand-built.

**v0.8.0 is where this was cashed in,** and the shape it took is worth recording,
because it is not the shape the ADR originally predicted. The decision anticipated
`step.waitFor`. What was built instead is *suspend in Postgres, resume on an
event*: a step that needs consent transitions the run to `awaiting_approval` and
the invocation **returns normally**, and a separate `resume-goal-run` function
picks the run back up when `APPROVAL_DECIDED` arrives.

The reason is ownership. `step.waitFor` holds a function open for the length of
the wait, and the state a user is looking at would then live in the queue rather
than in the database we already own -- where it is queryable, where an
approval row is a real row with a real deadline, and where a human can be shown
what is waiting. A crash-safety net still exists, and it is one query: a decided
approval whose step is still `awaiting_approval` is re-sent on the next sweep.

The `APPROVAL_DECIDED` event carries identifiers only. Which of the three
outcomes it is *not* in the payload, because the decision is already a fact in
Postgres and the function has to read it before it can act; naming it in the
message would add a second thing that can disagree with the database.

Trigger.dev is an acceptable substitute -- comparable durability, TS-native
background functions, a stronger local dashboard. QStash was rejected as
too low-level: it would leave the approval-suspension semantics to us.

**Consequences.**
- The Runtime's step boundaries become durable, so retries must be idempotent
  by construction (ADR-005).
- `scheduled-posts.ts` keeps its claim/lease logic as the *fallback* for the
  daily sweep; it is not deleted, it is demoted.
- We accept a vendor dependency and an outbound egress to Inngest's API. Tokens
  are not sent; the payload carries Run, Step and Approval identifiers only --
  and since v0.8.0 that includes no record of what a post said or how it was
  answered, so a queue that could be inspected cannot leak an unapproved draft.
- v0.8.0 added a second trigger alongside the scheduler's, so two invocations can
  reach the same step. A step is now **claimed** with a compare-and-swap
  (`UPDATE ... WHERE state = $expected`) rather than merely read, and a claim is
  handed back if execution cannot be attempted. See
  [`runtime.md`](./runtime.md#claiming-a-step-and-giving-the-claim-back).

**Revisit if** execution volume or cost makes the managed tier uneconomic, or
if data-residency requirements forbid a third-party control plane.

---

### ADR-002 — The Connector interface is defined in Phase 1, not Phase 3

**Status:** Accepted · Phase 0 (deviation from the original phase order)

**Context.** The roadmap as first drafted put "Runtime Foundation" in Phase 1 and
"Unified Platform API" in Phase 3. Building the Runtime first means building its
execution layer against *nothing*, then replacing the seam it was designed around
in Phase 3. That is a guaranteed rewrite of the most important code in the
product.

**Decision.** Define the `Connector` and `Capability` contracts at the end of
Phase 1, and immediately wrap the five existing publishers
(`instagram`, `facebook`, `threads`, `x`, `telegram`) in a thin adapter. No
behavior change. Phase 3 then becomes "implement the remaining capabilities and
standardize error shapes" rather than "replace the boundary."

**Consequences.**
- Phase 1 grows slightly; Phase 3 shrinks substantially and stops being risky.
- The adapter layer is throwaway *structure*, not throwaway code -- it is where
  the standardized errors and idempotency keys get filled in during Phase 3.
- `PLATFORM_IDS` and `PUBLISHING_CAPABILITIES` in `platforms.ts` become the
  seed of the capability registry rather than something replaced by it.

---

### ADR-003 — Execution state is server-authoritative

**Status:** Accepted · inherited from v0.1.0 remediation

**Context.** Already enforced for publish results: the client no longer submits
terminal success flags or result URLs, and the server action persists connector
outcomes. The same hazard reappears at every layer of the Runtime.

**Decision.** No client, tool argument, or AI-generated payload may set an
execution state, a result, or a result URL. The Runtime computes transitions and
persists them; clients render them.

**Consequences.** The AI cannot mark a step `completed` because it says so. A
tool returns a typed result, and the Runtime decides what that means for state.

**Extended in v0.8.0.** The same hazard reappears in a sharper form once a human
is in the loop, because "a person said yes" is exactly the sort of claim a client
could assert about a post it has not checked. So:

- A decision is recorded by `decideApproval` in a `server-only` module, checked
  against the **approval's own** `userId`, and nothing else -- not the step, not
  the run, not the queue. All of that is the resume path, so there is exactly one
  place where an approval becomes an action.
- A rejected edit never reaches the database. `applyEdit` hands the merged input to
  the *same* `validateToolInput` the plan gate uses, so a human writing input at
  the approval screen is held to the check that exists to stop untrusted output
  naming a destination.
- An approval's `input` column is authoritative over `run_steps.input`, and the
  resume uses it. What was approved is what publishes, and that is only true if
  the same values are used.

The pattern is the same as the AI case: the client says what it did, and the
server decides what that means.

---

### ADR-004 — Server actions stay thin; invariants live in server-only services

**Status:** Accepted · inherited from v0.1.0 remediation

**Context.** A browser-callable module is a privileged path by construction.
`actions/credentials.ts` was found to be one and its writer was relocated to
`src/lib/credential-store.ts`. (That adapter has since been deleted as dead
code — the per-platform credential path in `actions/platform.ts` superseded it
— but the writer it was guarding still lives in `credential-store.ts` and is
still reached through a browser-callable module.)

**Decision.** Server actions and route handlers perform authentication,
authorization, and validation, then delegate. Anything holding a secret, a state
transition, or an external side effect lives in a `server-only` module.

**Consequences.** Enforceable mechanically -- a lint rule or import-boundary
check should fail the build if a client component imports `server-only`. This is
a good Phase 8 candidate for a CI gate.

---

### ADR-005 — Every side-effecting step is idempotent

**Status:** Accepted · Phase 0

**Context.** ADR-001 makes retries automatic. Automatic retry of a non-idempotent
step -- publishing a post -- double-posts. The v0.1.0 scheduler already encodes
the correct instinct: `dispatch_started_at` marks the point after which an
outcome is *uncertain* and must never be blindly retried.

**Decision.** Every side-effecting step carries an idempotency key derived from
`(runId, stepIndex, targetAccountId)`. The connector records the key against the
platform response. A retry with a known key returns the recorded result instead
of re-dispatching.

**Consequences.** Connectors need a result cache keyed by idempotency key --
another concrete Phase 3 deliverable, and a reason to define the interface early
per ADR-002.

**Extended in v0.8.0.** The key alone is not sufficient, because it only helps
*connectors that implement the cache* -- and not all of them do. v0.8.0 added a
second trigger alongside the scheduler's (an approval decision wakes a run), so
two invocations can reach the same step and both would dispatch a publish. So
every step is now **claimed** with a compare-and-swap:

```sql
UPDATE run_steps SET state = 'running'
 WHERE id = $1 AND state = $2          -- the state it was expected to be in
```

Reading the state and then updating it is not the same thing; the gap between the
two is wide enough for both invocations to see `awaiting_approval` and both to
act. A claim is a *reservation* too, so a step that cannot be executed even to
completion hands it back -- to the state it was in, not to `failed`, because a
step left `failed` would be skipped as terminal on the retry and the run would
report success having published nothing.

This is the same instinct as `dispatch_started_at` -- mark the point before the
irreversible thing -- moved one layer inward, to the step.

---

### ADR-006 — Account and Connection are separate entities

**Status:** Accepted · Phase 0

**Context.** `social_accounts` today stores a token and one `platformAccountId`
in a single row, with no uniqueness constraint. `getConnectedAccount()` picks
`.limit(1)` by newest `connectedAt`. Phase 2 requires many accounts per platform
with independent enable/disable and capability sets.

**Decision.** Split into `connections` (the grant: encrypted tokens, expiry,
refresh state) and `accounts` (the identity: platform handle, display name,
enabled flag, capability set), related one-to-many. Goals target accounts.

**Consequences.** A migration with a backfill is required. Existing rows map
one-to-one, so the backfill is mechanical, but `ENCRYPTION_KEY` consistency
across environments (see `DEPLOYMENT.md`) must hold or every token becomes
unreadable. Migration notes ship with v0.4.0.

---

### ADR-007 — Semantic versioning with a per-phase release gate

**Status:** Accepted · Phase 0

**Context.** The roadmap mandates a real GitHub release per phase, with
implementation, tests, docs, changelog, version bump, and migration notes all
complete before a phase counts as done.

**Decision.**
- **v0.x** -- pre-1.0. Minor bumps may contain breaking changes; patch releases
  are backward compatible. This is the conventional meaning and it is honest
  here, because the data model *is* changing across Phases 2 and 4.
- **v1.0.0** -- the stability promise begins. From that point, minor bumps are
  backward compatible and breaking changes require v2.0.0.
- **Tags:** `vX.Y.Z`, annotated, created only from a green CI run on `main`.
- **Changelog:** Keep a Changelog format, newest first, with Unreleased on top.
- **Database migrations:** every migration is additive within a phase. Contract
  or destructive changes are deferred to a later phase and documented under
  *Migration Notes* in the release.

**Consequences.** Version lives in `package.json` and in this document; they are
bumped together. A phase is not complete until the CHANGELOG entry, the docs
update, and the tag all exist -- the "documentation-first rule" is enforced by
the release checklist, not by good intentions.

---

### ADR-008 — A page reads user data only through an owner-scoped read layer

**Status:** Accepted · Phase 7

**Context.** Phase 7 put a Runtime UI in front of data that has existed since
v0.3.0, and the first question was where a page should get a run from. There were
two functions that would work, and they are not equivalent:

- `runtime/service.ts::getRun(runId)` — what the executor and the resume path use.
- A reader that checks whose run it is.

The first is the right one for the Runtime. The queue hands a `runId` to a step
and has no idea who owns the run; the only way to know is a lookup, and doing it
on every step of every run to answer a question those callers do not have is a
real cost for no benefit. The second is the right one for a page.

The hazard is that both are called `getRun`-shaped things in the same module, and
nothing stopped a page from reaching for the cheap one. A run row contains the
plan, and the steps contain the **resolved** input — the actual post text, and a
media URL. A screen that renders what it gets shows one tenant's drafts to
another.

**Decision.** `runtime/queries.ts` is the only module UI code may read user data
through. Every function in it takes a `userId` and puts it in the `WHERE`
clause. The unscoped readers in `runtime/service.ts` stay, because the callers
that need them are correct, and are simply not reachable from a page.

The same rule was later applied to the pre-existing dashboard and analytics
reads, which now live in `dashboard/queries.ts` for the same reason and under
the same argument. Those readers took no arguments and resolved the ambient
session themselves, which made them unusable by any caller that already knew
whose data it wanted — the Assistant's context builder, which builds a system
prompt from exactly this data and is handed a `userId` by the authenticated
request it is serving. Their `app/actions` adapters were deleted once the last
caller went: the analytics page is a server component that reads the service
directly, and a `"use server"` module with no importer is an endpoint nothing
calls.

**Consequences.**

- **A known id belonging to someone else is `null`, not an error.** An error
  would distinguish "does not exist" from "not yours", which is a tenant
  enumeration oracle. `getRunDetail` returns `null` for both.
- **A filter can narrow, never widen.** `listRuns(userId, { goalId })` scopes by
  the *run's own* `userId`, not by looking up the goal first — so a `goalId`
  belonging to someone else matches nothing rather than matching their runs.
- **Scope is necessary but not sufficient.** A caller must also not render what a
  run *contains* to a reader who should not see it. Within this product that is
  the step input, and it is carried only by `getRunDetail`, never by the list
  shape — a list needs a title and a state, not a post body.
- **A limit cannot be asked past the cap.** `clampLimit` exists so a `?limit=` in
  a URL cannot ask for the whole table. A history too long for one page is a
  reason to build pagination, not to let a request size itself.
- **Two readers can disagree, so one owns each meaning.** `getRunDetail` reads
  the pending question from the *approval row*, not from `run.state`, because the
  approval is settled before the resume transitions the run: a page reading the
  state alone renders a question that has already been answered. And
  `countOverdueApprovals` uses `expires_at <= now`, the exact negation of
  `isOverdue`, so it counts what is *about* to fail rather than only what already
  has. The sweeper may be up to five minutes from marking an approval expired, and
  a dashboard reporting `overdue: 0` across four lapsed questions is the cheerful
  lie the count exists to prevent.
- **The deadline is computed with the server's own comparison.**
  `runtime/view.ts` calls `isOverdue` rather than re-deriving the arithmetic, and
  takes the clock as a parameter. If the screen used its own comparison, a user
  could watch a countdown reach zero, press Approve, and be refused with
  `approval_expired` — the screen said open and the server said closed, and both
  were right. The countdown is advisory; the label is authoritative.
- **A new state is a compile error.** The status tables are
  `Record<ExecutionState, StatusMeta>` and friends, so adding a state without
  deciding what it *means* fails `typecheck` rather than rendering a bare badge in
  one place. The tables are keyed exhaustively for the same reason the executor's
  state machine is.
- **Enforced, not merely documented.** `scripts/mutate-phase7.sh` removes the
  `userId` from each of these `WHERE` clauses in turn and requires the integration
  suite to fail; three further mutations are expected to break `typecheck` and
  `build` rather than a test. ADR-004 predicted that a `server-only` import
  boundary would be mechanically checkable — the last of those is that check.

**Related.** The UI is reorganised around the Runtime, so `/dashboard` now
redirects permanently to `/runtime` and the integration-centric pages are demoted
to a "Quick tools" group rather than deleted. The old `/accounts` credentials form
moved to `/settings/credentials`, and the OAuth failure redirects were repointed
to match, so a failed connect lands on the page where the fix is.

---

### ADR-009 — A step claim is a lease, not a flag

**Status:** Accepted · Phase 8

**Context.** `claimStep(stepId, from)` is a compare-and-swap: it updates the row
`WHERE id = $1 AND state = $2` and reports whether it won. The caller passes the
state it *read*, which is the live state, and the queue is at-least-once
(ADR-001). Those two facts together meant `claimStep(stepId, "running")` **succeeded**.

So a redelivery of the same event starts a second invocation while the first is
still inside the step body, both execute it, and both publish. The step's
idempotency key (ADR-005) does not save it: that only helps connectors which
implement the receipt cache, and not all of them do.

v0.8.0 tested this by claiming twice *from `pending`*, which passes and proves
nothing — `pending` is not the state a concurrent invocation ever observes.

**Decision.** A claim carries a lease. `claimStep` refuses a step observed in
`running` until its `started_at` is older than `STEP_CLAIM_LEASE_MS` (5
minutes), enforced in the same `WHERE` clause as the state comparison so the
refusal is atomic with the claim.

**Consequences.**

- **One predicate fixes two opposite problems.** Refusing `running` outright
  would trade a double-execution bug for a permanently stuck run, because
  `releaseStepClaim` runs in a `catch` and a worker killed outright never reaches
  one. The lease makes an unrecoverable crash eventually recoverable, and
  `releaseStepClaim` still makes a recoverable one immediate. Both are needed.
- **The lease is long on purpose.** A model call is bounded at 30s and a publish
  is bounded by the connector deadline (ADR-012), so a step still `running` after
  five minutes is not slow, it is gone. It is also the approval sweeper's
  cadence, so a reclaimed step is noticed on the same tick a lapsed approval is.
- **The clock is a parameter.** `claimStep(stepId, from, now)` takes `now` so the
  lease arithmetic is testable without waiting five minutes — the same rule
  `runtime/view.ts` follows for the approval deadline.
- **A stale claim is not automatically reclaimed.** Nothing sweeps it. A step
  recovers when the queue redelivers the run, which for a crashed step happens on
  the next retry. An explicit sweeper remains unbuilt and is named below.

**Deferred, deliberately.** Two related gaps are *not* addressed here and are
recorded rather than half-solved: there is no graceful shutdown (no `process.on`
handler anywhere), and no sweep for runs that are `running` with no live
invocation. Both need a runtime story — Inngest's `concurrency` and
`maxEvents` configuration, and a decision about what a shutdown means for an
in-flight publish — and neither is made better by half of it shipping first.

---

### ADR-010 — A security boundary lives in the query, not in the caller

**Status:** Accepted · Phase 8

**Context.** ADR-008 scoped the Runtime read layer: every function in
`runtime/queries.ts` takes a `userId` and puts it in the `WHERE` clause, because
the cheap unscoped readers in `service.ts` sit in the same file and nothing
stopped a page from reaching for one.

`lib/chat.ts` had the same shape and a different excuse. `ensureSession` did
check that a session belonged to the caller, so nothing was exploitable — but
`appendMessage`, `loadMessages`, `saveSummary` and `touchSession` each took a
bare `sessionId` and enforced nothing themselves. The guarantee was a property of
every *call site*.

Session ids are minted client-side, so they are attacker-supplied. One new
caller that skipped `ensureSession` would have had no second line of defence, and
the failure mode is a write into another user's transcript — a prompt-injection
channel into a system that acts on that user's behalf.

**Decision.** Every function in `lib/chat.ts` that touches a session takes a
`userId` and scopes in its own query: `loadMessages` inner-joins the session's
owner (messages have no `user_id` of their own — the owner is one join away, and
that join *is* the authorization), and the two updates add `userId` to their
`WHERE` clause. `appendMessage` checks ownership and throws, because silently
dropping a user's message would look like an assistant bug.

**Consequences.**

- **The two checks are not redundant.** `ensureSession` decides whether a *new*
  session may be minted for this user; these decide whether an *existing* row is
  this user's to read or write. Removing either leaves a hole the other does not
  cover.
- **Reads are scoped by returning nothing, writes by doing nothing.** A read for
  someone else's session is `[]`; an update is a no-op. Throwing on an update
  would make every caller handle an exception for a condition that is simply
  "not yours", and would make a wrong id louder than it needs to be.
- **The test holds the effect, not the signature.** "The function takes a
  `userId`" is not a property anyone can rely on — a test asserting it would
  still pass with the `WHERE` clause deleted. `tests/integration/chat.test.ts`
  seeds two users and asserts one cannot read or write the other's transcript, and
  the suite was confirmed to fail with the guards removed.

---

### ADR-011 — The OAuth `state` is signed, and PKCE is what closes the replay

**Status:** Accepted · Phase 8

**Context.** The `state` parameter was `base64url(JSON.stringify({ userId,
returnUrl }))` — the same encoding a client uses, with no signature and no
expiry. The callback's only check was `state.userId === session.id`, so the whole
defence against an account-link CSRF was *knowing the victim's user id*, which is
not a secret.

The attack: an attacker starts their own connect flow, takes the authorization
code returned to their own callback, and walks a victim through a callback URL
carrying that code and a `state` naming them. The victim's account is then linked
to the attacker's social account.

**Decision.** `lib/oauth-state.ts` signs the payload with `AUTH_SECRET`
(HMAC-SHA256, compared with `timingSafeEqual`) and puts `iat` *inside* the
signature. Verification happens **before** the parse: a signature that does not
verify means the bytes are not ours, and parsing them anyway would be treating
attacker input as state.

**Consequences.**

- **Signing closes the forgery; PKCE closes the replay. Neither substitutes for
  the other.** `state` is not single-use and this module does not make it so;
  a nonce would need a store. Replaying a *captured genuine* state still requires
  a `code` the platform issued for that flow, and the token exchange sends the
  `code_verifier` whose only copy is the httpOnly `pkce_<platform>` cookie. An
  attacker holding a captured state string does not hold that cookie, so the
  replay cannot complete. A nonce store would defend against a threat that PKCE
  already forecloses, at the cost of a table and a write on every connect.
- **The window is 10 minutes, matching the PKCE cookie's `maxAge`.** A state
  outliving its own verifier is a state that can no longer complete a flow, so
  accepting it longer buys nothing.
- **Expiry is inclusive, matching `isOverdue`.** Two places in one codebase that
  both mean "expired" should not answer differently at the boundary.
- **`safeReturnPath` is still applied afterwards.** A signature proves *we minted
  it*, not that the value is safe to use; a future caller could sign whatever it
  liked.
- **The Facebook GET branch still omits `code_verifier`.** That is per Meta's
  documented manual flow, and PKCE is optional on a branch that sends a client
  secret. Left as-is deliberately, and the reason is in the code.

---

### ADR-012 — Every outbound request has a deadline

**Status:** Accepted · Phase 8

**Context.** `fetch` has no timeout by default. A platform that accepts a
connection and then stops answering — a hung load balancer, a rate limiter
holding a request open, a DNS black hole — leaves the promise pending forever.
In Next.js that is a request that never returns and a server action that never
settles.

This is worse here than it would be in an ordinary app, because publishing is
*sequential within a run*: Instagram creates a container, polls it, then publishes
it; Threads is the same. One hung call is not one slow publish, it is a run
holding a claimed step and never settling. There were 27 such calls.

**Decision.** All outbound traffic goes through `lib/http.ts::fetchWithTimeout`,
with a 15-second default. A source-scanning test fails if any module outside
`lib/http.ts` calls `fetch` directly.

**Consequences.**

- **The test is the mechanism, not the edit.** Hand-editing 27 call sites is a
  change that is correct today and half-finished in six months. The guard fails
  the moment a twenty-eighth connector is written without a deadline — which is
  the moment it matters, and long before anyone notices a stuck run in
  production.
- **The caller's signal is composed, not replaced.** A caller with a shorter
  deadline must still win, or the helper would be a way of *extending* a request
  past the limit its own author set. A caller's abort is also not reported as a
  timeout, because "the platform did not respond" and "we cancelled" are
  different failures.
- **Errors name the host, not the URL.** Outbound URLs carry
  `?access_token=…`, and a timeout is exactly the error a user pastes into a
  support ticket. The full URL stays on the error object for a log somebody has
  consciously decided to write.
- **Existing behaviour is preserved by construction.** Every one of those call
  sites already had a `catch` that turns a throw into a failed result, so a
  timeout becomes an ordinary publish failure rather than a 500.
- **The claim lease (ADR-009) is the safety net, not the fix.** A five-minute
  lease bounds how long a stuck step blocks a run; the timeout is what stops the
  call being stuck at all.

---

## 6. Open questions

These were raised during Phase 0 and resolved here so the release gate is
satisfiable. Each records the default chosen and why, so a later phase can
revisit it deliberately rather than discover it.

| # | Question | Resolution |
|---|---|---|
| 1 | **LinkedIn is `connect_only` today.** The v1.0 flagship example publishes to LinkedIn. | **The example changes.** v1.0 acceptance criteria must not depend on an unwritten publisher. The canonical example uses **X + Instagram**, which both have working publishers today. LinkedIn publishing moves to a named post-v1.0 item. |
| 2 | TikTok, YouTube, Pinterest, Reddit — implement publishers, or stay connect-only? | **Stay connect-only through v1.0.** They remain connectable and appear in the capability registry with an empty capability set, so the Runtime reports them honestly instead of failing at execution time. Publishers are additive, post-v1.0. |
| 3 | Two documentation surfaces: `docs/*.md` vs `src/app/docs/*`. | **Confirmed split.** `docs/*.md` is **developer** documentation — architecture, runtime, connectors, deployment. `src/app/docs/*` is the **public in-app user guide** rendered as pages. The roadmap's `docs/*.md` list is developer-only; user-facing changes update `src/app/docs/*`. |
| 4 | Remediation Task 0 (secret inventory and rotation) before v0.2.0? | **Yes.** The non-rotational parts (permission check, name-only inventory, tracked-history scan) are done and recorded in `docs/security.md`. Actual rotation is an operational action for the owner of each credential. |
| 5 | Target schedule granularity, to size the queue plan quota. | **15 minutes** for v1.0. Fits the stated product need and keeps the run volume per goal predictable. Coarser cadences are expressed as multiple daily slots rather than as a new scheduling primitive. |
| 6 | `posts.platforms` becomes a join table in Phase 2 — migrate or drain first? | **Migrate additively.** Draining is not viable: users have scheduled posts. Add the table, backfill from the comma-separated column, keep a compatibility read path for one phase, and contract the old column in **v0.5.0**. **Executed:** `0011_post_targets_contract` dropped the column in v0.5.0. |

### Consequences of these resolutions

- The v1.0 flagship example is now *"every day at 10 AM, publish two AI-related
  posts on the Hilbras X and Instagram accounts."*
- Phase 3's scope shrinks: it standardizes five connectors rather than
  implementing ten.
- Phase 2 ships a compatibility layer, so its migration notes must state when
  the old column is removed (v0.5.0).

