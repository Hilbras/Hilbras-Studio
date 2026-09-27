# Hilbras Studio — Architecture

**Status:** Living document. Updated in the same phase as the code it describes.
**Current version:** v0.5.0
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
> writer was moved out of `actions/credentials.ts` into the server-only
> `src/lib/credential-store.ts` so the browser-callable module cannot be used as
> a privileged path. Keep that pattern.

#### Services / Domain

- **Owns:** all business rules, invariants, and state transitions.
- **Must:** be marked `import "server-only"` (18 modules already are).
- **Must not:** be imported by client components.
- **Location:** `src/lib/**` (becomes sub-packages in v1.0).

#### Connectors *(new — Phase 3, interface defined in Phase 1)*

- **Owns:** translating a **capability** call into a platform API call, and
  translating the platform's response/error back into the standard shape.
- **Must not:** leak platform-specific types, error strings, or auth flows above
  this layer. The Runtime must never see a Facebook Graph error code.
- **Location:** `src/lib/connectors/<platform>/`.

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
- **Location:** `src/lib/ai.ts`, `ai-sdk.ts`, `ai-budget.ts`, `chat.ts`.

#### Tools *(Phase 5)*

- **Owns:** exposing AI-callable actions as typed tools with declared
  preconditions, timeouts, and idempotency keys.
- **Must not:** bypass the Connectors layer, or perform a side effect that the
  approval policy has not cleared.
- **Location:** `src/lib/tools/**`.

#### Runtime *(Phase 1)*

- **Owns:** Goal -> Plan -> Run -> Step -> Result, execution state, retries,
  scheduling, and approval suspension.
- **Must not:** contain platform-specific logic, and must never talk to a
  platform API directly -- only through Connectors.
- **Location:** `src/lib/runtime/**`, `src/lib/runtime/functions/**` (Inngest).

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
| `PUBLISHING_CAPABILITIES` | `status: "supported" \| "connect_only"` is a boolean wearing a type. Cannot express `get_posts`, `delete_post`, or per-account capability sets. | Phase 3 |
| `scheduled-posts.ts` | Claim/lease logic is correct and proven, but is bound to the `posts` table and a daily Vercel cron. Generalize into the Runtime. | Phase 1 |
| `actions/*.ts` (13 files) | Some still mix validation with orchestration. Thin them per section 2.1. | Phases 1-4 |
| `src/app/docs/*` (7 pages) | Public in-app user guide. Distinct from `docs/*.md`, which are developer docs. Reconcile explicitly. | Phase 0 (this doc) |

### 3.3 Retire

| Asset | Reason |
|---|---|
| `src/lib/mock-data.ts` | Dashboard is now live. Confirm no remaining imports, then delete. |
| `vercel.json` cron entry | Replaced by the durable queue (ADR-001). Kept only as a fallback sweep. |
| `data/hilbras.db` | SQLite artifacts. The app is Postgres-only. Not tracked by git; delete locally. |

---

## 4. Target architecture (v1.0)

### 4.1 Runtime data model

```
Goal ──1:N──> Run ──1:N──> Step ──N:1──> Account
 │             │            │
 │             │            └── tool invocation (capability + args + result)
 │             └── execution state, attempt count, idempotency key
 └── schedule, constraints, target accounts, policy
```

Execution states: `pending -> running -> (completed | failed | cancelled)`,
plus `awaiting_approval` as a **suspension**, not a terminal state. A suspended
run holds no lease and consumes no budget.

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
  -> Runtime creates Run (idempotency key = goal + schedule slot)
  -> AI Planner produces a Plan: ordered Steps with typed tool references
  -> Plan validated against account capabilities + policy before execution
  -> Steps execute through Tools -> Connectors
  -> Side-effecting steps check the approval policy
       -> auto        : proceed
       -> approval    : suspend Run, emit ApprovalRequest
       -> disabled    : fail the Step with a policy error
  -> Verify step confirms the real platform state
  -> Report generated
```

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
first-class primitive (`step.waitFor` / `step.sleep`) rather than a state machine
hand-rolled on a queue. Phase 1's Plan -> Step model maps 1:1 onto Inngest steps.
Phase 5 re-planning and Phase 8 crash recovery, retries, and idempotency are
platform-provided rather than hand-built.

Trigger.dev is an acceptable substitute -- comparable durability, TS-native
background functions, a stronger local dashboard. QStash was rejected as
too low-level: it would leave the approval-suspension semantics to us.

**Consequences.**
- The Runtime's step boundaries become durable, so retries must be idempotent
  by construction (ADR-005).
- `scheduled-posts.ts` keeps its claim/lease logic as the *fallback* for the
  daily sweep; it is not deleted, it is demoted.
- We accept a vendor dependency and an outbound egress to Inngest's API. Tokens
  are not sent; the payload carries Run and Step identifiers only.

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

---

### ADR-004 — Server actions stay thin; invariants live in server-only services

**Status:** Accepted · inherited from v0.1.0 remediation

**Context.** A browser-callable module is a privileged path by construction.
`actions/credentials.ts` was found to be one and its writer was relocated to
`src/lib/credential-store.ts`.

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

