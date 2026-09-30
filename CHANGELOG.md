# Changelog

All notable changes to Hilbras Studio are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor versions may contain breaking changes — see
[ADR-007](docs/architecture.md#adr-007--semantic-versioning-with-a-per-phase-release-gate).

Tags are `vX.Y.Z`, created only from a green CI run on `main`.

## [Unreleased]

Nothing yet.

## [0.11.0] — 2026-09-30

The Task 17–18 tranche: the "use server" boundary becomes a layer, the
observability the plan asks for, and the release gate starts checking its own
evidence. Twenty-three commits, 71 files. Internal — no user-facing change.

**The action boundary is now a layer (Task 17).** `src/app/actions/` no longer
contains logic. Prompts, output sanitizers and spend control moved into a
server-only `ai/composer`; provider resolution, chat wrappers and the background
memory/summary jobs became server-only modules behind the unchanged `@/lib/ai`
barrel; the dashboard and analytics reads became an owner-scoped read service in
`src/lib/dashboard/queries.ts`; the settings page reads AI providers through a
server-only service. The 975-line publisher became `src/lib/publish/` — types,
shared account/Graph helpers, five per-platform connectors, and the routing
core — with an identical public API. Action modules are thin adapters that keep
only the session gate and input validation. **This is a breaking change to
internal module boundaries** (permitted pre-1.0 by ADR-007); no route, action
name or user-facing behaviour changed.

**DTOs leave the "use server" modules.** Client components type-imported shapes
that were defined inside `use server` files, which forced server-only modules
into the browser graph. They now live in plain modules, which is what let
`prefers-reduced-motion` and the bundle work below happen.

**Observability (Task 18).** Structured JSON event logging — one line per event
for publish runs, token failures, AI budget denials and account deletion,
replacing prose `console` calls on the paths the plan names. Accessibility is a
CI gate: `jsx-a11y` recommended rules on every lint, which caught a scrim that
was a `div` doing a button's job (now a labelled button).

**Reduced motion.** `MotionConfig reducedMotion="user"` at the theme provider,
honouring the OS preference across all 26 animated components.

**A client bundle budget.** `pnpm bundle:budget` measures per-route JS from the
emitted HTML and fails on regression; wired into CI after the build.

**Data integrity.** Migration `0017` adds CHECK constraints to the four
remaining unguarded state columns — `runs.state`, `run_steps.state`,
`run_step_approvals.state` and `goals.status` — so an invalid state is rejected
at the database rather than being read back as a corrupt row. The two hot-path
indexes have `EXPLAIN` evidence recorded as a test (`index-plans.test.ts`).

### Migration notes

`drizzle/0017_state_checks.sql` adds four CHECK constraints
(`runs.state`, `run_steps.state`, `run_step_approvals.state`, `goals.status`).
It is additive and cannot lose data, but **it can fail to apply**: a row that
already holds a value outside the vocabulary makes the `ALTER TABLE` fail.

**Run the preflight first:**

```
psql "$DATABASE_URL" -f drizzle/0017_state_checks.preflight.sql
```

Every query must return **zero rows**. Each returns the offending rows if any
exist; correct them (or decide the vocabulary is wrong) before applying 0017,
and do not widen the CHECK to fit a bad row — that discards the guarantee the
migration exists to provide.

The preflight is SELECT-only and has been tested against both a clean database
and one holding a deliberately corrupt row, in
`tests/integration/state-check-migration.test.ts`. That test runs the file from
disk rather than duplicating its queries, and was verified by mutation: a typo
in a table or column name fails it, and so does a predicate widened to accept
the bad value — the failure mode that would report "clean" in production while
blocking nothing.

**It has never been run against production data,** because that is not possible
from the development environment. Treat the first production run as the real
one.

### Verification

500 unit tests (45 files) · 205 integration tests (17 files) · typecheck clean ·
lint 0 errors / 27 warnings · build green. All four mutation harnesses were run
against this tree: phase 6 **20 covered / 0 holes**, phase 7 **16 / 0**,
phase 8 **23 / 0**, task 17 **21 / 0**.

The harnesses are not in CI — each mutation starts a Postgres container, so they
take tens of minutes and run before a release instead. `pnpm release:check` now
accounts for that: it reads a date from `.mutation-harness-verified` and fails
if the tree has changed since. Repairing the phase-6 harness found a mutation
that had matched nothing since Phase 8, so the compare-and-swap guarantee had
been unchecked for two phases; `src/mutation-harness.test.ts` now applies every
pattern in all four harnesses in the unit suite, so that failure takes seconds
to catch rather than a release cycle.

**Not verified.** No browser accessibility smoke test (no Playwright), no
external-call latency baseline, no staging or production run of anything in
this release.

## [0.10.0] — 2026-09-29

A stabilization tranche, and the first release that is not a roadmap phase. It
carries the security and data-integrity work tracked in
[`tasks/todo.md`](./tasks/todo.md) — fifteen commits that had never been
released, including outbound-request and OAuth fixes, three migrations, and
self-serve account export and deletion.

### Security

- **A publish result URL from a connector is no longer trusted.** Every
  permalink is now validated server-side (`src/lib/result-url.ts` — `https`
  only, host restricted to the platform that was published to) at all five
  permalink construction sites and at both result funnels. A connector that
  returns `javascript:…`, an internal host, or a lookalike domain no longer has
  it rendered as a link.
- **Reserved network ranges are now refused, not just private ones.**
  `net-guard.ts` blocks TEST-NET-1/2/3, `192.0.0.0/24`, and multicast/broadcast in
  addition to loopback, private, link-local, metadata, and CGNAT — v4 and v6.
- **Outbound requests no longer follow redirects, and response bodies are
  bounded.** `fetchWithTimeout` uses `redirect: "manual"` (a 3xx surfaces to the
  caller's existing `!ok` handling rather than being followed somewhere else) and
  caps every body at 2 MiB inside the total deadline. The assistant stream now
  cancels upstream generation when the client disconnects.
- **OAuth `state` is signed and expired**, so it cannot be forged with a
  victim's `userId`, and X and Reddit exchange their codes with HTTP Basic
  credentials — the client secret never appears in a request body.
- **An unresolvable OAuth profile fails the connect.** Six non-Meta platforms now
  resolve real account ids through documented profile endpoints; one that cannot
  be resolved returns `profile_unavailable` instead of storing a colliding
  `"unknown"` id that would merge two people's accounts.

### Data integrity

- **Migration 0014** adds a CHECK on `posts.status` (five terminal states) and a
  partial unique index allowing only one default AI provider per user. Connection
  registration, provider selection, and the provider save path are now
  transactional.
- **Migration 0016 converts every bare `timestamp` to `timestamptz`** (33 columns
  across 19 tables), so no stored instant depends on the timezone of whoever reads
  it. This **reverses a deferral recorded twice** in the task ledger, and its
  safety rests on one precondition: `AT TIME ZONE 'UTC'` asserts the stored
  wall-clock *was* UTC. True on Vercel Postgres; on a self-hosted database with a
  non-UTC server it would shift every timestamp by the offset. Run
  `SHOW timezone;` before applying. There is no safe rollback.
- **Migration 0015** adds `inbox_read_state` so a message stays read across
  fetches, pruned on a 30-day window.

### Added

- **Self-serve account export and deletion.** `src/lib/account-lifecycle.ts` is
  the tenant boundary: `/api/account/export` streams the caller's complete data
  inventory as JSON with every secret reduced to a presence flag, and
  password-confirmed deletion removes the user plus the `rate_limits` rows its id
  keys, in one transaction. Two-tenant integration tests prove one user's
  export and deletion cannot touch the other's.
- **Inbox read state**, per message, scoped to the user and platform.
- Contract tests for the OAuth provider matrix, and for X's rotating refresh
  token being maintained by the cron.

### Changed

- A failed inbox provider fetch is now reported per platform ("X: …") instead of
  rendering as an empty inbox, which read as "nothing new".
- The four preference toggles that changed no behavior are removed from the UI.
  A toggle that does nothing is a false claim; the columns are retained and
  documented for reintroduction.
- The analytics query is bounded at 500 rows, and counts partial success.
- Goal-run publishes in the analytics dashboard are recorded **out of scope**:
  receipts record successes only, so merging them into a published/failed split
  would distort the statistics. Run outcomes remain visible in the Runs view.

### Truthfulness

The pricing page no longer quotes unimplemented tiers, trials, or seats;
fabricated testimonials are removed from the landing page; the GDPR compliance
claim is dropped; and the privacy policy now describes the retention, export, and
deletion behavior that actually exists.

### Removed

- `src/lib/mock-data.ts` (zero importers) and four unused direct dependencies
  (`@tanstack/react-query`, `zustand`, `@hookform/resolvers`, `react-hook-form`).

### Tests

- **Migration 0016 is now actually tested.** The task ledger recorded it as
  "verified by the full integration suite", which was not true — the suite
  *applied* 0016 as part of the migration chain and asserted nothing about it.
  `tests/integration/timestamptz-migration.test.ts` stages the journal at 0015,
  writes a row through the pre-0016 schema, applies the real 0016, and asserts
  that a bare timestamp *did* resolve to different instants per session, that the
  instant is unchanged afterwards, that a `NULL` stays `NULL`, and that the
  already-correct `goals.next_firing_at` is left alone. Two drift guards read the
  migration file itself; both were confirmed to fail against a deliberately wrong
  zone.
- Migration notes for 0014, 0015, and 0016 — preflight, repair, and rollback —
  now live in `tasks/todo.md`, which the task ledger's own definition of done
  requires for any database change.

**Verification:** 455 unit tests, 179 integration tests across 15 files, clean
typecheck, lint 0 errors / 29 warnings, green production build.

## [0.9.5] — 2026-09-29

v1.0 hardening. A hardening phase is mostly the phase where you find out what the
earlier ones were wrong about, and two of the fixes below are for defects
introduced *by* shipped releases.

### Fixed

- **A step could be executed twice, concurrently.** `claimStep` was a
  compare-and-swap from whatever state the caller *read* — which is the live
  state — so `claimStep(stepId, "running")` **succeeded**. The queue is
  at-least-once, so a redelivery of the same event started a second invocation
  while the first was still inside the step body; both executed it, and both
  published. The step's idempotency key did not save it: that only helps
  connectors which implement the receipt cache, and not all of them do. The
  v0.8.0 test claimed twice *from `pending`*, which passes and proves nothing,
  because `pending` is not the state a concurrent invocation ever observes.
  Claims are now leases (ADR-009).
- **The middleware did not run on the four screens v0.9.0 was about.** Phase 7
  added `/runtime`, `/runs`, `/goals` and `/approvals` to the `PROTECTED` list in
  `src/proxy.ts` and not to the `config.matcher`, so the edge redirect and the
  auth-POST throttle silently did not apply to them. Nothing failed — every page
  checks its own session — which is why nothing caught it. `src/proxy.test.ts`
  now holds the two lists together.
- **`runs.error_summary` was never written.** The column existed since v0.5.0,
  was selected by `queries.ts`, typed in two DTOs, and rendered in a panel on the
  run detail page. A failed run showed an empty error box, permanently. The `fail`
  event now carries a `summary`, supplied by the code that knows the reason —
  `planRun`'s refusal, the `no_steps` backstop, or the first failing step's
  connector error.
- **An empty secret could be encrypted but never decrypted back.**
  `decryptSecret` guarded its three payload parts with a truthiness check, and
  `encryptSecret("")` writes a zero-length ciphertext whose `base64url` is `""` —
  so the module refused a payload it had just written. Found by writing
  `src/lib/crypto.test.ts`, which did not exist until this release.
- **The Instagram inbox request truncated itself.** The access token was
  interpolated raw into a query string. Tokens routinely contain `&`, `=`, `+` and
  `/`, so a token containing `&` silently cut the request short and returned an
  empty message list with a `200` — which reads as "no new messages", not as a
  bug. Built with `URLSearchParams` now.
- Removed `getCredentialValue` from the credentials action: an exported
  plaintext-secret getter in a `"use server"` module with no callers.
- Corrected two comments that described systems which do not exist — a
  "run-timeout sweep" in `runtime/state.ts`, and a claim comment that described
  the lease as an unbounded hold.

### Security

- **The OAuth `state` was unsigned and unexpiring.** It was
  `base64url(JSON.stringify({ userId, returnUrl }))` — the same encoding a client
  uses — and the callback's only check was `state.userId === session.id`. The
  entire defence against an account-link CSRF was *knowing a victim's user id*:
  an attacker took a code returned to their own callback and walked a victim
  through a callback URL naming them, linking the attacker's social account to
  the victim's. `state` is now signed with `AUTH_SECRET` and verified **before**
  the parse (ADR-011).
  - It is deliberately **not** single-use. Replaying a captured genuine state
    still needs a `code` issued for that flow, and the exchange sends the
    `code_verifier` held only in an httpOnly cookie. **Signing closes the forgery;
    PKCE closes the replay.** A nonce store would defend against a threat PKCE
    already forecloses, at the cost of a table and a write on every connect.
- **Both secrets were checked for presence and not for length.** `ENCRYPTION_KEY=a`
  and `AUTH_SECRET=x` were valid production configurations: the deployment
  started, encrypted every stored token and signed every session cookie with
  something derived from one character, and nothing reported a problem. Both now
  require 32 characters in production and fail startup with the command to
  generate a proper one.
- **`AUTH_SECRET` was read through two copies of the same function** — one in
  `src/proxy.ts`, one in `src/lib/session.ts` — so a fix to one would not have
  reached the other. Now one module, `src/lib/secret-key.ts`.
- **No outbound request had a timeout.** `fetch` waits forever by default, and
  publishing is *sequential within a run* — Instagram creates a container, polls
  it, then publishes it — so one platform that accepted the connection and stopped
  answering left the run holding a claimed step and never settling. All 27
  outbound calls now go through `fetchWithTimeout` with a 15-second default, and
  a source-scanning test fails if any module calls `fetch` directly (ADR-012).
- **The assistant's transcript queries were scoped by nothing but a
  client-supplied session id.** `loadMessages`, `appendMessage`, `saveSummary` and
  `touchSession` each took a bare `sessionId`. `ensureSession` did check
  ownership, so nothing was exploitable — but the guarantee was a property of
  every *call site* rather than of the module, and session ids are minted
  client-side. All four now take a `userId` and scope in their own `WHERE` clause
  (ADR-010).
- `HttpTimeoutError` reports the **host**, not the URL. Outbound URLs carry
  `?access_token=…`, and a timeout is exactly the error a user pastes into a
  support ticket.

### Added

- `docs/development.md` — the one document the roadmap named and the repository
  did not have. The invariants a change must not break, the enforced checks, the
  three drift guards, the mutation-harness rules, and the two reasons the harness
  can lie.
- `src/lib/secret-key.ts` — one reader for `AUTH_SECRET`, shared by the Edge
  middleware and the session module, with the production strength rule.
- `src/lib/http.ts` — outbound HTTP with a deadline. The only place `fetch` is
  called, enforced by a test.
- `scripts/mutate-phase8.sh` — 23 mutations, 0 holes.

### Changed

- A claim is a lease: a `running` step is not re-claimable until
  `STEP_CLAIM_LEASE_MS` (5 minutes) has passed. Five minutes is generous on
  purpose — a model call is bounded at 30s and a publish is bounded by the
  connector deadline, so a step still `running` after that long is not slow, it is
  gone. `releaseStepClaim` still makes a recoverable crash immediate; the lease
  makes an unrecoverable one eventual.
- `claimStep(stepId, from, now)` takes the clock as a parameter, so the lease
  arithmetic is testable without waiting five minutes — the same rule
  `runtime/view.ts` follows for the approval deadline.

### Not changed, on purpose

- **`execution_policies` still do not gate manual or scheduled publishes.** They
  are consulted before the Runtime runs a step, so they govern AI-planned runs
  only. Gating the composer and the scheduler would mean a manual publish stops
  working for anyone holding a `disabled` policy — a visible regression in
  exchange for a guarantee about a code path the policy was never designed to
  govern. If you set a platform to `disabled`, a post you schedule by hand will
  still publish. This is the one change in this release that alters what an
  existing setting means, which is why it is here rather than in the code.
- **No audit log.** Logins, failed logins, connects, disconnects, credential
  changes and policy changes are still unrecorded. It is a table, a migration,
  six writers and a screen; an audit log that misses the event you are
  investigating is worse than knowing there is not one.
- **No `kid` in the ciphertext**, so `ENCRYPTION_KEY` cannot be rotated. Adding
  one changes the stored format of every secret and needs a migration, and a
  migration that is wrong is unrecoverable in a way that a missing feature is not.
- **No graceful shutdown, no stale-`running` sweep, no Inngest
  `concurrency`/`throttle`/`maxEvents`, no outbound token revocation.** All
  recorded with reasons in `docs/runtime.md` and `docs/security.md`.
- **No tests for `runtime/inngest/functions.ts`** (crash recovery, retry,
  concurrency, resume). The largest remaining gap, and the reason two of the bugs
  above went unnoticed for a release.

### Test counts

Unit 421 (from 371) · integration 168 (from 151) · lint 31 warnings, 0 errors
(baseline held) · `scripts/mutate-phase8.sh` 23 mutations, 0 holes.

## [0.9.0] — 2026-09-28

Studio UI 2.0. The Runtime has been complete since v0.8.0 and none of it was
visible: every capability — goals, plans, runs, approvals, policies — had a
service function and no screen. A user who set an `approval` policy had no way to
answer the question it created. This release is the interface, and the part of it
worth reading about is the read layer the interface needed.

### Added

- **An owner-scoped read layer** (`src/lib/runtime/queries.ts`, `server-only`) —
  the only module UI code may read user data through.
  - **`runtime/service.ts` has readers that are deliberately unscoped.**
    `getRun`, `listRunSteps`, and `listRunEvents` take a `runId` and nothing else,
    because the executor and the resume path are handed a run id by the queue and
    cannot ask whose run it is. They are the right functions for the Runtime and
    the wrong ones for a page: a run row holds the plan, and the steps hold the
    *resolved* input — the real post text and a media URL. They stay, because the
    callers that need them are correct; they are simply not reachable from a page.
  - **Every function here takes a `userId` and puts it in the `WHERE` clause**, not
    in a filter applied afterwards, so a row that is not the caller's never exists
    in memory to be rendered by mistake. Run ids are `randomUUID`, so the
    unscoped readers are not *practically* guessable — but "not practical" is not a
    property a tenancy boundary should rest on.
  - **A known id belonging to someone else is `null`, not an error.** An error
    would distinguish "does not exist" from "not yours", which is a tenant
    enumeration oracle. `getRunDetail` returns `null` for both.
  - **A filter narrows, never widens.** `listRuns(userId, { goalId })` scopes by
    the *run's own* `userId`, not by looking up the goal first, so a `goalId`
    belonging to someone else matches nothing rather than matching their runs.
  - **`clampLimit` caps every list** at 200, so a `?limit=` in a URL cannot ask
    for the whole table. A history too long for one page is a reason to build
    pagination, not to let a request size itself.
  - See [ADR-008](docs/architecture.md#adr-008--a-page-reads-user-data-only-through-an-owner-scoped-read-layer).
- **A shared state vocabulary** (`src/lib/runtime/view.ts`, pure) — state to
  label, tone, and meaning, with no fetch and no formatting of user text.
  - **The tables are `Record<ExecutionState, StatusMeta>`** and friends, so adding
    a state without deciding what it *means* is a `typecheck` failure rather than a
    bare badge in one place. The status tables are keyed exhaustively for the same
    reason the executor's state machine is.
  - **`approvalDeadlineView` calls the server's own `isOverdue`** rather than
    re-deriving the comparison, and takes the clock as a parameter. If the screen
    used its own arithmetic a user could watch a countdown reach zero, press
    Approve, and be refused with `approval_expired` — the screen said open, the
    server said closed, and both were right. The countdown is advisory; the label
    is authoritative.
  - **Unknown values resolve to an explicit "Unknown"** rather than a guess, so a
    state written by a later build renders readably here instead of being
    mislabelled.
- **The Runtime dashboard** (`/runtime`) — active goals, runs in flight, failures
  this week, connected accounts, everything waiting on you, and the recent runs.
  - **A run waiting on a person is not counted as in flight.** It is holding a
    question, not doing anything, and it is counted on its own. A dashboard
    reporting "2 in flight" when one of them is waiting on you sends you to the
    wrong screen.
  - **"Failed this week" is a seven-day window on purpose.** A count of all
    failures ever only goes up and says nothing about whether the system is
    healthy now.
  - **Goals that will not fire are counted.** If a goal targets an account that is
    switched off, disconnected, or can no longer publish, nothing errors and no
    run is ever created — the goal simply goes quiet, forever. It is the one
    Runtime problem that never appears in the run history. A *paused* goal is not
    counted: a paused goal not firing is why you paused it.
- **Goals UI** (`/goals`, `/goals/new`, `/goals/[goalId]`) — create and configure
  a goal, pause, resume, and archive it, with its firing history and every run it
  has made. The gate that validates a goal at save time is the same one from
  v0.6.0; the screen renders its issues verbatim.
- **Approvals UI** (`/approvals`) — the open questions, oldest deadline first,
  with approve, reject, and edit-before-approve. **The client never decides
  state**: no optimistic transition, no local copy. The card renders the action's
  return value including every validation issue, and derives its editable fields
  from `editableFields(getTool(...))` rather than hardcoding them, so the screen
  cannot offer a field the tool would refuse.
- **Execution history** (`/runtime/runs`, `/runs/[runId]`) — every run, and a log
  per run: the plan, each step in order with its exact input and output, and a
  timestamped event trail.
- **Policies UI** (`/settings/policies`) — `auto` / `approval` / `disabled` per
  account and per tool, rendered from the server's own result rather than an
  assumed next value. Lists only what `describePolicyTargets` may name: a control
  for `compose_post` would be a switch that does nothing.
- **Account management** (`/accounts`) — enable, disable, and disconnect a
  connected account, with the reason it is unusable shown on the account itself.
- **`src/lib/runtime/inngest/wake.ts`** — the queue-wake rule, extracted from a
  private function in a `"use server"` module and taking its sender as a
  parameter, so "a failed send is not a failed approval" can be tested by handing
  it a sender that throws. It could not be reached before without a session, a
  form post, and a database — a test expensive enough that it would not have got
  written, which ADR-004's own reasoning predicts.
- **Seven UI primitives** — `table`, `textarea`, `select`, `checkbox`, `separator`,
  `tabs`, `progress`; `badge` gained the six tone variants `view.ts` defines. No
  new dependencies; every Radix primitive was already installed.
- **User guide** — Runtime, Goals, Approvals, and Execution policies pages under
  `src/app/docs/*`, in a new "Goals & Runtime" nav group.

### Changed

- **`/dashboard` is a permanent redirect to `/runtime`.** The URL is the one most
  bookmarks and screenshots already carry, and a 404 on it would be a worse
  answer than a redirect.
- **The integration-centric pages are demoted, not deleted.** Dashboard (the old
  one), Assistant, Accounts, Composer, Scheduler, Inbox, and Analytics are now a
  "Quick tools" group in the sidebar. They still work; removing a working screen
  to make a redesign look decisive would be a worse outcome than a slightly busier
  sidebar.
- **`/accounts` is now connected-account management.** The credentials form moved
  to **`/settings/credentials`** (`git mv`, so history follows), and the OAuth
  failure redirects in `authorize`, `callback`, and `safeReturnPath` were repointed
  to match — a failed connect now lands on the page where the fix is.
- **`GOAL_STATUSES` / `GoalStatus` moved to `src/lib/goals/validation.ts`**, which
  is pure, and are re-exported from `goals/service.ts`. A client component needs
  the vocabulary to label a goal, and vocabulary is not a secret; behind a
  `server-only` import, copying the list would have been the only way out.
- **`listRecentRuns` gained `createdAt`** — the only timestamp every run has, and
  the one a list orders by.
- **`PROTECTED` routes extended** to `/runtime`, `/runs`, `/goals`, and
  `/approvals`.
- **The status badge takes a tone** from `view.ts`'s `Tone` union, with `neutral`
  as the default so a missing tone renders readably rather than invisibly.

### Testing

- **`tests/integration/queries.test.ts`, 25 tests.** Almost entirely about
  separation, because that is the property that cannot be checked without two
  users against one database: two tenants' runs, run details, goals, and
  approvals each stay with their owner; a `goalId` filter cannot widen scope; a
  known foreign id is `null`; the overview's counts are the caller's counts; the
  pending question is read from the approval row and not from `run.state`; the
  overdue count sits exactly on the boundary `isOverdue` enforces; a goal that
  cannot act is counted and a paused one is not; and `clampLimit` clamps.
- **`src/lib/runtime/view.test.ts`, 26 tests** — every status, the deadline view
  at and around the boundary, and the non-guessing fallbacks.
- **`src/lib/runtime/inngest/wake.test.ts`, 4 tests** — the send shape, and that a
  rejection, a non-`Error` rejection, and a synchronous throw are all swallowed.
- **Unit 371 (was 341), integration 151 (was 126), lint unchanged at 31 warnings.**
- **`scripts/mutate-phase7.sh` — 16 mutations, 0 holes.** Each removes the
  `userId` from a different `WHERE` clause, inverts a state predicate, drops the
  limit cap, or re-derives the deadline comparison, and requires the suite to
  fail. Every expression is deliberately type-valid: the integration suite is
  transpiled, not typechecked, so a mutation referencing an unimported helper
  would die of a `ReferenceError` and report "ok" for a file that no longer runs.
  Three mutations are expected to break `typecheck` and `build` rather than a
  test — that is the `server-only` import boundary ADR-004 predicted would be
  mechanically checkable.

### Fixed

- **`tests/integration/goals.test.ts` asserted a hardcoded `nextFiringAt`** while
  `updateGoal` recomputes from the wall clock, so the test only passed between
  midnight and 06:30 Berlin each day — it was one afternoon away from breaking
  CI. It now asserts the property the recomputation exists to provide: the stored
  time is 06:30 in the schedule's own timezone, and in the future. That is also
  correct across a daylight-saving boundary, which a UTC comparison would not be.

### Not included, deliberately

- **Cursor pagination.** Run lists and event logs use recent-N with a cap, chosen
  over cursors because a run history is read top-down and almost never deep. A
  user who genuinely needs page 40 of the event log is a use case to design
  against, not to pre-build for.
- **Real-time updates.** The Runtime is server-rendered and revalidates on
  action. Nothing polls, and nothing is pushed. A second tab does not update on
  its own, which is a defensible thing to notice and not a bug.
- **Wiring the plan gate's `policy` input**, still deferred exactly as in
  v0.8.0. `validatePlan` accepts one and would report a `disabled` step as an
  issue; the repair that invites is to drop the step, which for a goal targeting
  two accounts would take the permitted account's post down with it. The dispatch
  gate remains the live one.
- **Bulk policy editing.** One account or tool at a time. A multi-select would
  need its own confirmation surface, and a bulk `disabled` that partially applies
  is a bad thing to have designed quickly.
- **Per-goal execution limits in the UI.** The counters are enforced
  (`perPlan 2`, `perStep 2`, `perRun 12`) and were not made editable, because an
  editable limit with no explanation of what happens when it is hit is a support
  ticket waiting to happen.
- **A re-planning path after a mid-run failure**, still deferred as in v0.7.0.

---

## [0.8.0] — 2026-09-28

Human-in-the-Loop. A plan could publish, and nothing in the product could stop
it: `awaiting_approval` had been modelled and unit-tested since v0.3.0 and
nothing ever suspended on it, so the one state that says *a person should look at
this* was a state the Runtime could reach only by hand. This release is where a
person gets a vote.

**Service only.** The approval interface is Phase 7, so a policy set
programmatically takes effect immediately, and a suspended run already sits in
the database waiting for a decision that today arrives through code rather than a
button. Everything below is the system behind that screen.

### Added

- **Execution policies** (`execution_policies`, migration `0013`) — `auto`,
  `approval`, or `disabled`, per account or per tool, with **per-account beating
  per-tool**. Purely additive: no backfill, because the default is the absence of a
  row and every existing user already has the absence.
  - **The default is `auto`.** Every existing user publishes unattended today, and
    a new deployment should work before it has been configured. A default of
    `approval` would leave every existing account with a queue of posts nobody
    asked for.
  - **`disabled` fails without asking.** Asking a human to approve something their
    own policy forbids is asking them to override their own configuration, and the
    question would be a trap whose only outcome is to contradict the setting that
    produced it.
  - **Two refusals, both at write time.** A policy on a tool that changes nothing
    (`compose_post`) and a policy on an account the user does not own are both
    refused rather than accepted and ignored — a dead setting a user believes is
    live is worse than a refusal. **Clearing is always allowed**, including for an
    account no longer held, because a stuck setting is worse than a stale one.
  - **An unrecognised stored value resolves to "no rule"**, not to the nearest
    thing this build knows. The value that matters is `approval`, and a settings
    screen from a later build must not be read by this one as permission to
    publish unattended.
- **The permission gate** (`src/lib/runtime/approval-store.ts`) — one question
  every side effect passes through, with three answers: `allow`,
  `needs_approval`, `deny`. It is built **once per run**, not once per step, and a
  suspended run builds a fresh one — which is the case that matters, because a
  user who switches to `disabled` while their post waits must be re-read.
  - **`ToolSpec.sideEffect` is the discriminator**, a declared field rather than
    `capability !== null`. A future read-only connector tool delegates to a
    platform and has no side effect, and the derived version would put a question
    in front of a step that cannot publish anything.
  - **It sits after `$ref` resolution and before the connector lookup.** The
    person has to be shown the real text, and a forbidden action should not cost a
    database read: "you may not do this" beats "you might not be able to".
  - **`disabled` is checked *before* a recorded approval.** A user who leaves a
    post waiting, then disables publishing, then comes back and approves — because
    the screen is still open — has not overridden their own setting. An approval
    is consent to a permitted action, not a licence to perform a forbidden one.
  - **`ExecutorDeps.approval` is required, with no default.** A permissive default
    means forgotten wiring publishes unattended, invisibly. The v0.7.0
    `defaultDeps` — which held a registry-only resolver and, as of this release, a
    gate that allowed everything — is **deleted**, with a note at its old location
    explaining why: an unused object that assembles a working set of dependencies
    is an invitation.
- **Approvals** (`run_step_approvals`, same migration) — the question, the answer,
  and a deadline.
  - **The snapshot holds the *resolved* input.** A `publish_post` step normally
    takes its text from an earlier `compose_post` as `{"$ref": …}`, and a screen
    showing a reference is a screen showing a JSON object. The approval is taken
    after resolution, so the person reads what will be published and an edit is an
    edit of real text.
  - **What was approved is what publishes.** The resume hands the executor the
    approval row's input, not `run_steps.input` — the plan's record still holds the
    `$ref`, which may resolve to something other than what was shown. Anything else
    makes the approval a formality. `UNIQUE (step_id)`: a step executes once, so it
    can be asked once.
  - **Edits are validated by the plan gate's own `validateToolInput`**, now
    exported from `plan.ts` and shared rather than reimplemented. An approval
    screen is a *later* stage than the gate, and a weaker check there would make
    the one place a person reads the content the one place it is unchecked.
    `publish_post.text` is the only editable field; `mediaUrl` is a new capability
    being granted, not an edit.
  - **A `$ref` in an edited value is refused.** Valid *plan* input, and the shared
    validator rightly accepts one — but an edit is a literal, and an object shaped
    like a reference is a client bug or an attempt to redirect the publish.
  - **The target platform's real character limit is applied**, so an over-long edit
    is refused with "this platform allows 280" rather than accepted and later
    rejected by the platform, after the person had said yes.
  - **A rejected key short-circuits the merge.** Reporting "text must be non-empty"
    for a `text` the person did not submit describes a document they never wrote.
- **Suspension and resumption** (`inngest/functions.ts`) — a step that needs
  consent ends in `awaiting_approval`, the run transitions, and the function
  **returns normally**.
  - **A suspension is a return, not a throw.** It does not ask the queue for
    another attempt, because another attempt would arrive at the same question and
    asking twice is not a way of asking better. The run now lives in Postgres
    rather than in the queue.
  - **The resume is a separate function** (`resume-goal-run`, triggered by
    `APPROVAL_DECIDED`). `execute-goal-run` claims a schedule slot and `createRun`
    is idempotent on it, so a resume arriving as another `GOAL_SCHEDULED` would be
    absorbed. The claim is what makes at-least-once safe (ADR-005), so it stays
    intact and the resume gets its own trigger. Both call a shared `advanceRun`.
  - **Planning is skipped on a resume.** `planRun` charges a model call *before* it
    discovers the plan already exists, so calling it would spend a call to be told
    about the plan this run already has.
  - **The event carries ids only** — no content, and no record of which of the
    three outcomes it is. The decision is already a fact in Postgres and the
    function must read it before it can act, so naming the outcome in the message
    would add a second thing that can disagree with the database. A queue that
    could be inspected is not a queue an unapproved draft can come to rest in.
  - **A claim on every step**, a compare-and-swap (`UPDATE … WHERE state =
    $expected`). A second trigger now exists alongside the scheduler's, so two
    invocations can reach one step, and a read-then-update has a window between
    them wide enough for both to dispatch. The step's idempotency key does not save
    it: that only helps connectors which implement the result cache.
    `releaseStepClaim` returns a claim to the state the step was in — not to
    `failed`, which would be skipped as terminal on the retry while the run
    reported success having published nothing.
- **Approval timeout** — 24 hours, stamped on the row at creation, so changing the
  default later cannot shorten a window a user is counting down. `expires_at` is
  `timestamptz` because it is compared against `now()` in a query (the migration
  0012 lesson). A timeout **fails the step, never auto-approves**: publishing
  because the user was asleep is the opposite of what "require approval" asked
  for. The reader closes the window too, not just the sweeper, and both use the
  same boundary, so a decision cannot be refused by one and published by the
  other.
- **The approval sweeper** (`settle-approvals`, on the same `*/5` tick) — expires
  what nobody answered, and re-sends decisions whose step is still
  `awaiting_approval`. The second query is the safety net for a crash between "the
  person said yes" and "tell the queue", and it costs one query because a decision
  is "picked up" exactly when the step it was about stops being `awaiting_approval`.
  That is what makes suspension *durable* rather than usually durable, and it is
  why no outbox table is needed.
- **`policy_denied`, `approval_rejected`, `approval_expired`** in
  `ConnectorErrorCode`, all non-retryable. A policy is a configuration, not a
  transient fault, and a timeout has to be nameable so the history can say which of
  the three things happened.
- **`ToolField.editable`** on the tool spec, set on `publish_post.text` only.
- **Docs** — `docs/runtime/approvals.md`, `docs/runtime/permissions.md`,
  `docs/runtime/policies.md`; `execution.md` and `runtime.md` rewritten around
  suspension, claiming, and the gate; `architecture.md` §4.1, §4.3, ADR-001,
  ADR-003 and ADR-005 extended with what shipped.

### Changed

- **Two state transitions changed meaning.** v0.3.0 shipped `reject →
  cancelled` and `approval_timeout → failed`; **both now resume the run to
  `running`**. They made a human decision about *one step* decide the fate of
  *every other step* — a goal pointed at X and Instagram whose X post is rejected
  should still post to Instagram, which is the settle-independently rule v0.5.0
  already applies to every other kind of step failure. Treating a human "no" as a
  cancellation would make the one failure a user caused behave differently from
  every other failure, and the user would have to learn that rule separately. The
  difference is recorded on the step. `cancel` remains the one decision that ends a
  run, and `FINISHES_RUN` lost `reject` and `approval_timeout` — stamping
  `finished_at` would mark a run finished while it was still executing.
- **`StepExecution` is an exhaustive discriminated union** on `state`
  (`completed` | `failed` | `awaiting_approval`), with the unused fields spelled
  `undefined` so `result.error?.code` still reads at unnarrowed call sites and
  narrowing is enforced everywhere else.
- **`validateToolInput` is exported** from `plan.ts`, and `approval-store.ts`
  depends on it. One validator, not two that drift.
- **`goal-migration.test.ts` stages a truncation rather than a hole.** It removed
  only 0012's journal entry, which was correct while 0012 was the newest migration
  and silently wrong the moment 0013 was added: Drizzle applies everything later
  than the high-water mark, so the staged database applied 0013, 0013 became the
  mark, and the real 0012 was then *behind* it and skipped. The column never
  appeared and the test failed on a `SELECT`, four assertions from the cause. The
  precondition test now asserts both the absent column and the absent tables.

### Testing

- 341 unit tests (was 307) and 126 integration (was 85). New:
  `runtime/approvals.test.ts` (24) and `tests/integration/approvals.test.ts` (41);
  seven gate tests in `runtime/executor.test.ts`; two tool-registry tests; the
  updated transition table in `runtime/state.test.ts`.
- **Nineteen mutations were checked against the new invariants, and the first pass
  found a hole that turned out to be the mutation's fault and one that might not
  have been.** Marking `mediaUrl` editable instead of `text` found a real gap in
  intent — the original expression added a *duplicate* `editable: true` to a field
  that already had one, which changes the file and changes no behaviour, and a
  test suite that passed under it was correct to pass. Rewritten to target the
  guarantee actually claimed. Also verified: never calling the gate, asking about
  the raw `$ref`, checking the account before permission, checking `disabled`
  after a recorded approval, dropping the ownership check on a decision, letting a
  second answer overwrite the first, answering after expiry, recomputing the
  deadline at read time, accepting a policy on someone else's account, reading an
  unrecognised decision as a real one, inverting the sweeper's boundary, not
  finding an unpicked-up decision, skipping the shared validator, un-approving a
  delivering tool, re-asking a refused question, returning a rejected run to
  `cancelled`, and un-CASing the step claim and its release. All nineteen fail
  without the code. `scripts/mutate-phase6.sh` is checked in.
- **A boundary was self-contradictory and is now fixed.** `isOverdue` used `<=`
  while the integration test asserted the opposite. The window *closes* at the
  deadline, so at the deadline it is closed: `now >= expiresAt`, and the sweeper's
  query is `expires_at <= now()` — the exact negation, so the reader and the
  writer cannot disagree about which side a decision fell on.

### Not included, deliberately

- **The approval interface.** Phase 7 (v0.9.0). A goal is created and a policy is
  set through services; there is no screen for either, and the question a suspended
  run is waiting on has no button. This release is the system behind it.
- **A per-policy timeout.** A fixed 24-hour window, stamped at creation, so a
  configuration change cannot move a deadline somebody is counting down.
- **Wiring the plan gate's `policy` input.** `validatePlan` accepts one and would
  report a `disabled` step as an issue; `planRun` does not supply it. A
  `policy_disabled` issue is a *repair* signal, and the repair it invites is to
  drop the step — so for a goal targeting two accounts where one is disabled, the
  planner would drop it, fail `uncovered_goal_target`, and take the permitted
  account's post down with it. Failing the disabled step at dispatch and continuing
  to its sibling is strictly better, and is the rule every other step failure
  already follows. The input stays available and tested; the dispatch gate is the
  live one.
- **A suspended run does not block the next firing.** `next_firing_at` already
  advanced at dispatch, so a user who is slow to approve accumulates a backlog
  rather than silently losing firings. The alternative means one missed approval
  deletes a week of posts.
- **A retry of a resumed run.** A resume is the same attempt continuing — it has
  no attempt number and no schedule slot — so a retryable failure there waits for
  the next scheduled firing, which is also what stops a second attempt
  re-publishing a post that went out while the person was deciding.

## [0.7.0] — 2026-09-27

AI Planning. A goal fired and did nothing: the Runtime was complete, and nothing
had ever written a `run_steps` row, so every firing was a no-op reporting
success. This release is where a plan comes from — and it is the first release in
which a model's output causes something to happen in the world.

### Added

- **Tool registry** (`src/lib/runtime/tools.ts`) — the central new abstraction of
  this release, and the answer to a problem the roadmap created for itself. A
  **capability** is what a *platform* can do; a **tool** is what a *step* may
  invoke, either delegating to a capability (`publish_post`) or run by the
  Runtime itself (`compose_post`). The roadmap's own example plan is *research →
  ideas → posts → validate → publish → verify*, and five of those six steps are
  not platform capabilities, so one vocabulary could not describe them. The
  namespaces overlap and are **not** equal: `get_account` is a real capability
  with no step behind it, and the gate refuses it by name. `run_steps.capability`
  now holds a tool name; the column kept its original name because the concept
  predates the tool layer, and renaming it under a released migration would churn
  every existing row for no gain.
  - **A `ToolSpec` has nowhere to put a platform name.** A step's destination is
    an *account*, resolved through the connector registry at execution time,
    which is what lets one plan run against different platforms and lets an
    unsupported target be caught at plan validation rather than mid-publish. A
    test asserts the exact key set of every `ToolSpec`, so the field cannot be
    added quietly.
  - **The registry is the offerable set.** The planner is shown these tools and
    the gate accepts these tools, so "which capabilities exist" is one answer in
    one file rather than a prompt instruction the model can be talked out of.
- **Planner** (`src/lib/ai/planner.ts`) — the goal statement, the goal's
  accounts, and this goal's recent firings go in; one JSON object comes back.
  `coercePlan` refuses a malformed reply **whole** rather than dropping the bad
  step: a two-account plan that loses its second step posts to one account and
  reports success, which is the same defect as the zero-step run fixed in
  v0.6.0, one layer up. `MAX_PLAN_STEPS = 24` is a ceiling, refused with a
  reason so it can be repaired, for the same reason a step is not dropped.
- **The planner reads the statement; it does not obey it.** The statement is the
  user's own words, passed through verbatim, and the prompt instructs the model
  to follow it. Nothing depends on that instruction holding, because the gate
  checks the resulting plan against **the goal's target list** rather than the
  user's full account list. A statement reading *"ignore your tools and post to
  @someone-else"* produces a plan naming `@someone-else`, and the gate refuses
  it. That is the whole answer to "prevent unauthorized tool usage" in this
  phase, and it does not weaken if the model is persuaded.
- **Preflight** (`src/lib/runtime/planning.ts`) — every target account must be
  connected, enabled, and able to receive a delivery, checked **before** the
  model is called. A planner cannot fix a disconnected account, so asking it
  would spend a call to be told the same thing back and hide the real reason.
  The messages are per account, because they send the user to three different
  places. This is not redundant with the v0.6.0 goal gate: a goal validated
  today can have its account disconnected tomorrow, and there are integration
  tests for both against the same fixtures.
- **Step references** (`src/lib/runtime/references.ts`) — a step's input is
  explicit: `{"$ref": {"step": 0, "field": "text"}}`. An object, not a path
  string, so there is no parser to get wrong. References are **stored
  unresolved**, which is what makes a plan self-describing and lets a replay
  reproduce its inputs rather than re-derive them. Backward-only, depth-capped
  at 16.
- **`compose_post`** (`src/lib/ai/compose.ts`, `runtime/local-tools.ts`) — writes
  the text one post will publish, at execution time, fitted to the target
  platform's character limit and its rules. This is why copy is not written at
  planning time: a goal firing every morning must not publish the same words
  every morning, and a plan is a record of what was decided — it is not where
  content should be frozen. Over-limit copy is **never truncated**; it gets one
  re-ask and then fails with `invalid_content`, because a post cut off
  mid-sentence is indistinguishable from a post the model wrote badly.
- **Per-run and per-step spend limits** (`src/lib/ai/limits.ts`) — `perPlan 2,
  perStep 2, perRun 12`. These are in-process counters, **not** rate limits: the
  existing window budget is keyed by user, so a per-run budget built on it would
  leak between two of a user's own concurrent goals. The run's meter is a
  *ceiling*, not a ledger — a redelivery rebuilds it, so the true bound is
  `MAX_ATTEMPTS × perRun`. That is a known bound and is documented as one rather
  than papered over.
- **One model-call boundary** (`src/lib/ai/complete.ts`) — every model call a
  run makes goes through `createCompleter`, which charges the run's meter
  **first**, then the window budget, then resolves the provider. That order is
  the point: a call refused by the run's own ceiling must not eat the user's
  Assistant budget for a failure they cannot act on. Four typed failures with
  the right `retryable` flag each, and `budget_exhausted` added to
  `ConnectorErrorCode` — a spent per-run budget does not clear with time, so it
  is never retryable.
- **`listFiringHistory`** (`src/lib/goals/service.ts`) — this goal's recent
  firings, reduced to whether they worked: the slot, the run state, the step
  count, and which tool failed. The failed step is a **tool name** rather than a
  message, because a run's `error_summary` can contain a connector's own text and
  a connector message can contain whatever the platform chose to echo. The run
  being planned is excluded from its own history. Both are decisions in one
  place, and both are reversible in one place.

### Changed

- **The plan gate validates against the tool registry** rather than
  `CAPABILITY_NAMES`, and gained `uncovered_goal_target`. A goal pointed at X and
  Instagram that posts only to X used to look like it worked; that is how a user
  finds out their second account went quiet. Coverage keys off
  `deliversToAccount`, a **separate field** from `capability !== null` — if
  `compose_post` counted as coverage, a plan that drafted for both accounts and
  published to neither would validate.
- **The gate's account lookup is narrowed to the goal's targets.** A convention
  nobody is forced to follow is not a gate: left resolving from the user, a plan
  naming a valid account the goal does not target would have passed.
- **The executor dispatches through the tool registry**, resolves `$ref` against
  settled results, and gates a step whose dependency did not complete. Three
  independent checks refuse a step fed by a step that failed, and each is
  sufficient alone; they are layered because *which one fires decides the
  message*, and a user whose draft step failed needs to be pointed at that step.
  "…which did not run" and "…which produced nothing" are the same code and a
  materially different next action.
- **Execution** (`runtime/inngest/functions.ts`) — a `plan-run` step between
  starting a run and loading its steps, with the shared spend meter, the
  `createCompleter` for the planner, and a `priorResults` map rebuilt from
  persisted rows and filled from the step memo *outside* the closure, so a replay
  still populates it.
- **`docs/architecture.md`** — the Tools layer now describes what shipped rather
  than what was planned, and section 4.3's execution flow is annotated with the
  version each line arrived in.

### Testing

- 307 unit tests (was 180) and 85 integration (was 70). New:
  `runtime/tools.test.ts`, `runtime/references.test.ts`, rewritten
  `runtime/plan.test.ts`, extended `runtime/executor.test.ts`,
  `ai/limits.test.ts`, `ai/planner.test.ts`, `ai/context.test.ts`,
  `ai/compose.test.ts`, and `tests/integration/planning.test.ts`.
- **Six mutations were checked against the new invariants, and two of them found
  holes rather than confirming what was hoped.** Removing the executor's
  dependency check did **not** fail a test — because the resolver refuses the same
  input independently. The two checks are genuinely redundant as *safety*; what
  distinguishes them is the message. The comments claiming otherwise were
  wrong, and are now corrected, and the tests assert the message so each layer
  is covered on its own rather than by the other still standing. Also checked:
  stopping the `$ref` resolver, un-narrowing the gate's account lookup, removing
  the coverage check, making `persistPlan` overwrite instead of refusing a second
  write, and removing the history exclusion. All six fail without the code.

### Not included, deliberately

- **Human approval of a plan.** Phase 6 (v0.8.0). Everything is published
  automatically the moment a plan passes the gate. This is the release where that
  stops being true, and it is the reason the queue was chosen.
- **Re-planning after a mid-run failure.** A refused plan gets exactly one repair,
  with the gate's own issue text verbatim, and only before any step has run. A
  planner shown *"step 2 failed"* and asked for a new plan is being asked to
  solve the problem by removing the thing that failed, and the step that failed is
  the reason the run exists. The outcome to avoid is a goal that quietly stops
  publishing because one bad Tuesday convinced the model that publishing was
  optional. The run fails, the next firing generates a fresh plan, and the history
  records what happened.
- **A migration.** `runs.plan`, `run_steps`, and the unique `idempotencyKey` all
  already existed from v0.3.0. Nothing in this phase needed a schema change.
- **The content of previous posts in the planner's context.** A planner shown
  what it wrote last time is measurably worse at writing something new, and the
  standard fix is to feed it its own history — which would mean handing the model
  the user's entire published archive on every firing.
- **The Goals UI.** Phase 7 (v0.9.0), unchanged from v0.6.0. A goal is created
  through the service and fires correctly; there is no screen for it yet.

## [0.6.0] — 2026-09-27

The Goal Engine. Until this release the Runtime was complete and dark:
`executeGoalRun` waited for a `GOAL_SCHEDULED` event that nothing sent, and there
was no way to create, edit, or stop a goal. A goal is now a thing that fires.

### Bug Fixes

- **A run with no steps reported `completed`.** Nothing in the codebase has ever
  written a `run_steps` row — that is Phase 5's planner — so a goal fired, loaded
  zero steps, executed nothing, and settled as a successful run. The user saw a
  green run and no post. A no-op that reports success is the worst outcome
  available to this system, so `executeGoalRun` now records a `run.no_steps` event
  and fails the run with outcome `no_plan`. The gap is loud, in the run's own
  history, instead of silent.

### Added

- **Cron engine** (`src/lib/goals/cron.ts`) — five-field parsing with macros,
  names, ranges, steps, and lists; Vixie's rule that two restricted day fields are
  OR'd, not AND'd; and next-firing arithmetic that is correct across daylight
  saving. A schedule is a **local wall-clock** promise, so a skipped hour is
  skipped and a repeated hour fires **once** — the alternative would be a
  duplicate publish, the one failure mode the rest of the Runtime spends so much
  machinery preventing. No new dependency.
- **Validation gate** (`src/lib/goals/validation.ts`) — pure, so it is testable
  without Postgres. A goal is configured once and then forgotten, so an account
  that is disconnected, switched off, or incapable has to be refused **while
  someone is looking at the form**. It returns every issue rather than the first,
  and distinguishes `unknown_account`, `account_disabled`, and
  `capability_unavailable` — three problems that send the user to three different
  places. It refuses this phase's own roadmap example, because LinkedIn completes
  OAuth and has no publisher: a goal saved there would look configured and never
  publish.
- **Interval floor** — two firings of one goal may be no closer than 15 minutes
  (`MIN_GOAL_INTERVAL_MS`). A goal publishes on every firing, so this is the floor
  on how often the product can post to one account on a user's behalf; well inside
  every platform's rate limit, and below the frequency at which repeated posts get
  a grant revoked. Enforced by probing real consecutive slots, because
  `0,5,10 * * * *` and `*/5 * * * *` are the same schedule and only the gap is the
  property that matters.
- **Prefill** (`src/lib/goals/parse.ts`) — reads the platforms, cadence, and time
  out of the sentence the user is going to write anyway. It is a prefill, not an
  interpreter: it never invents an account key (a sentence names a *platform*,
  only the user knows which of their three accounts), never proposes a schedule
  its own validator would reject, and lists what it did **not** read. A
  prefill's first job is to say *"linkedin is connected but cannot publish yet"*
  at typing time rather than at the first firing.
- **Goal service** (`src/lib/goals/service.ts`) — the only module that writes
  `goals`, and there is no exported function that writes a schedule which has not
  been through the gate. Edits re-validate the **whole** goal, a refused edit
  changes nothing, pausing clears the firing time, and resuming recomputes it from
  now rather than replaying the slot that was missed. Health is derived from the
  last run, never denormalised onto the goal.
- **Scheduler** (`src/lib/goals/scheduler.ts` and an Inngest cron function) — finds
  due goals every five minutes and advances each **before** dispatching it. The
  reverse order is survivable but wedges a goal on a loop that can never get past
  the slot that killed it; advancing first cannot double-publish. The next slot is
  computed from *now*, so firings missed during an outage **collapse into one
  run** rather than arriving as a burst.
- **Migration 0012** — `goals.next_firing_at timestamptz` and a partial index
  (`status = 'active'`), so finding what is due is one index scan instead of a
  cron evaluation per active goal per tick. The column is timezone-aware on
  purpose: every other timestamp in this schema is a bare `timestamp` read in the
  session's `TimeZone`, which would make the same row read differently depending
  on which pooled connection served the query. Active goals that predate the
  column are backfilled to `now()` — a schedule that has already passed *is* due,
  and nothing recorded whether it was ever served.

### Changed

- `docs/goals.md` rewritten for the shipped behaviour. It previously said "Phase 4
  parses [the statement]" and listed goal creation, scheduling, and pause/resume
  as unbuilt; it now describes what exists and states plainly that *interpreting*
  the statement is Phase 5's planner, which reads it verbatim.
- `docs/runtime.md` no longer says a run "executes whatever steps are persisted"
  now that zero steps is a failure rather than a success.

### Testing

- 180 unit tests (was 98) and 70 integration (was 44). The DST cases are named
  after the situations they cover — gap, fold, no-DST zone, half-hour offset,
  midnight rendering.
- `tests/integration/goal-migration.test.ts` exists as its own file because **a
  backfill cannot be tested from a database that has already migrated**: rows
  inserted after a full `migrate()` supply the column themselves, so the test
  would pass with the `UPDATE` deleted. That file stages the migrations up to
  0011, inserts, then applies 0012.
- The three load-bearing new tests were mutation-checked — deleting the migration's
  `UPDATE`, flipping the DST fold from earliest to latest instant, and making pause
  leave a stale firing time in place. Each one fails, and each was restored.

### Not included, deliberately

- **The Goals UI.** Phase 7 (v0.9.0). This release ships the engine and the
  service those screens will call.
- **Natural-language planning.** Phase 5 (v0.7.0). The statement is stored and
  served verbatim; the prefill above is the honest limit of what a rule can read.
- **A per-goal catch-up queue.** Missed firings collapse to one run, and a failed
  dispatch loses one firing rather than retrying it, because a retry would need
  somewhere to record what the firing still owes. That is the delivery guarantee
  Phase 8 hardening is for.

## [0.5.1] — 2026-09-27

Unified Platform API, part 2 of 2. Capability sets replace the publish
boolean, the connector registry becomes the single gate, and production
execution finally resolves accounts through the accounts table.

### Bug Fixes

- **The Runtime resolved a connector from the account key's *prefix*.** The
  Inngest function passed `defaultDeps`, whose resolver reads the platform off
  `"x:hilbras"` and cannot consult the database. So a **disabled account still
  published**, an unknown key still dispatched, and a user's second X account
  was indistinguishable from their first — the publisher then fell back to
  whichever connection was newest. `createAccountResolver` existed and was
  unwired: the account model shipped in v0.4.0 and execution never used it.
  Production now uses `resolverForUser(userId)`, which refuses a disabled or
  unresolvable account instead of publishing anyway.
- **The capability gate trusted the adapter's self-declaration.** The executor
  checked `connector.capabilities.includes("publish_post")`, so an adapter
  asserting a capability the product does not grant could publish. An adapter is
  the module that performs the publishing; letting it also grant itself the
  permission to publish made "add a publisher" a one-line edit inside the thing
  doing the publishing. The gate now reads the registry, which cannot be edited
  from inside an adapter.

### Improvements

- **`status: "supported" | "connect_only"` is gone.** It was a boolean wearing a
  type: it could answer "can it publish?" and nothing else, so `get_posts` and
  `delete_post` had nowhere to live, and a connect-only platform was
  indistinguishable from one whose publisher merely had a bug.
  `PUBLISHING_CAPABILITIES` now carries real capability sets, and
  `capabilitiesForPlatform()` / `platformSupports()` replace the status tests.
  `isPublishablePlatform()` is now derived from `publish_post` rather than
  declared.
- **New `src/lib/connectors/registry.ts`** — the seam. `lookupCapability()` is
  the one gate every capability call passes through, and it returns a *reason*,
  not a null: `unsupported` ("this platform cannot post") and `not_connected`
  ("reconnect this account") send the user to different places, and collapsing
  them makes a product limit look like the user's mistake.
- **Adapters derive their capability set from the registry** instead of
  restating it, so the two declarations cannot drift.
  `src/lib/connectors/registry.test.ts` fails if they do.
- `CAPABILITY_NAMES` moved to `src/lib/platforms.ts`, the lowest layer of the
  vocabulary, so the UI and the connector contract read one list.
  `connectors/types.ts` re-exports it, so connector code has one import site.

### Documentation

- `docs/capabilities.md` — **new.** The vocabulary, the three levels (platform /
  account / connector) and why they differ, and why the registry is the
  authority.
- `docs/platform-development.md` — **new.** Adding a publishing platform end to
  end, in dependency order, with a definition of done.
- `docs/connectors.md` — capability table, the registry's authority, and an
  honest note that the legacy string bridge did *not* land here.
- `docs/accounts.md`, `docs/architecture.md`, `README.md`, `ROADMAP.md` updated.

### Breaking Changes

- **`PublishingCapability.status` is removed.** Use
  `capabilitiesForPlatform(id)` or `platformSupports(id, capability)`. For
  internal callers `isPublishablePlatform(id)` is unchanged.
- **`PublishingStatus` is no longer exported.**

### Migration Notes

No database migration. `accounts.capabilities` already stores capability names
and `capabilitiesForAccount()` already preferred the account's stored set, so
per-account capability narrowing works today; only the platform-level
declaration changed shape.

## [0.5.0] — 2026-09-27

Unified Platform API, part 1 of 2. The last of the legacy data model is gone:
`post_targets` is now the only record of where a post goes, and the Runtime's
target model can finally express *which account* a post goes to.

### Features

- **`post_targets` is authoritative.** `posts.platforms` — the comma-separated
  `"instagram,x,facebook"` string — is dropped. It could not be counted,
  indexed, joined, or narrowed to a specific account, and it had accumulated
  four independent `split(",")` implementations, each with its own idea of what
  to do with an empty segment. All four now read the join table.
- **`post_targets.account_key` can address an account.** The column existed but
  nothing wrote it, because the Composer offers platforms and not accounts. It
  is now covered by the uniqueness constraint, so per-account targeting needs no
  further migration. See [`docs/accounts.md`](docs/accounts.md).
- **One row per (post, platform, account), enforced by the database.**
  `UNIQUE NULLS NOT DISTINCT (post_id, platform, account_key)`. `NULLS NOT
  DISTINCT` is the load-bearing part: `account_key` is NULL for a
  platform-level target and Postgres treats NULLs as distinct in a unique index
  by default, so a plain constraint would accept the same pair twice.
- **`getPostTargets(ids)`** reads targets for up to 50 posts in one query. The
  analytics, dashboard, and scheduler views each did one lookup per post before.
- **New `PostItem.platforms` is `string[]`**, not a string. The type now matches
  what the code always did to it.

### Bug Fixes

- **A post's targets could be recorded more than once.** `setPostTargets`
  documented itself as replacing the previous set but only ever appended, and
  its `onConflictDoNothing()` was inert — the table carried no unique constraint
  for it to conflict against. Every re-write of a post's platforms grew the row
  set, and since the read paths report one platform per row, a post aimed at one
  platform could render as "3 platforms" in the Composer and Scheduler. The
  write now deletes before it inserts, and the constraint closes the concurrent
  case. Covered by `tests/integration/post-targets.test.ts`.
- **A post and its targets were two separate writes.** A failure between them
  left a post that exists, is schedulable, looks normal in the Composer's list,
  and then fails at publish time with "Post has no target platforms" — hours
  later, for something the user never saw go wrong. Both writes are now one
  transaction, owned by `src/lib/posts/service.ts` (ADR-004 keeps orchestration
  out of the server action).
- **`PlatformIcon` threw on an unrecognised platform id.**
  `PLATFORM_REGISTRY[platform].name` is a `TypeError` on any value not in the
  registry, and ids reach this component from stored data — a post's targets, an
  account's platform, a stored publish result. The Composer already produced the
  literal `"unknown"` here, so a post with no recorded target could crash the
  page rather than render. An unknown id now renders a neutral dot labelled
  "Unknown platform".
- **Eight `as never` casts on `PlatformIcon` props are gone.** They were
  silencing exactly that type error: `platform={x as never}` compiles against
  any value, so the crash could never be caught at the call site where it
  originated. The prop is now honestly typed and every call site is checked.

### Improvements

- Post creation moved out of `createPostAction` into a server-only service, and
  the first `db.transaction()` in the codebase was introduced. The transaction
  handle type is derived from `db.transaction` rather than hand-written, so a
  Drizzle upgrade cannot silently drift it.
- **Fixed an inverted check in the release gate.** `release:check` verified that
  HEAD had *not* been pushed, while its own error message told you to push the
  release commit before tagging. With any upstream configured the check could
  never pass, so no release could clear the gate. It now verifies HEAD **is**
  pushed, which is what the message always meant and what ADR-007 requires.

### Documentation

- `docs/accounts.md` — `account_key`'s role, and the migration status for both
  contractions.
- `docs/architecture.md` — §3.2 marked done, §6 resolution 6 marked executed.
- `README.md` — status table and capabilities heading moved to v0.5.0.

### Breaking Changes

- **`posts.platforms` is dropped.** Any query selecting it fails; use
  `getPostTargets()`. Hand-written SQL touching that column must move to
  `post_targets`.
- **`PostItem.platforms` is `string[]`.** Client components that called
  `.split(",")` on it must drop the call.
- **`setPostTargets(tx, postId, platforms)` takes a transaction** as its first
  argument. It is no longer callable outside one, by design.

### Migration Notes

`0011_post_targets_contract` is the second irreversible step in the ADR-006
chain, and it is ordered so the old column is destroyed last:

1. Backfills target rows from `posts.platforms` for any post written since 0008.
2. Collapses duplicate rows the unconstrained table accumulated.
3. **Aborts** if any post would be left with no target row. The column is still
   present at this point, so the backfill can be re-run by hand.
4. Adds the unique constraint.
5. Drops `posts.platforms`.

```bash
npx drizzle-kit push        # or: pnpm exec drizzle-kit migrate
```

If step 3 raises, the fix is to populate the missing `post_targets` rows from the
still-intact `posts.platforms` column and re-run. Do not drop the column by hand.

No application downtime: every read path uses the join table, and step 1 runs
before anything is removed.

## [0.4.1] — 2026-09-27

Publish receipts. A retried run step could publish twice; it now cannot.

### Bug Fixes

- **A retried run step could double-post.** The run-level guard only protects
  *within* one run, and a retry is a **new** run with a new id — so its step
  keys differed and nothing stopped the second dispatch. This is the dependency
  v0.3.0's release notes flagged ("connectors need a result cache before a
  partial re-run is safe").
  - `publish_receipts` (migration `0009`) is keyed on the step's derived
    idempotency key and stores the platform's own `post_id` and `permalink`, so
    a redelivery reports where the post actually went rather than a bare
    "already done".
  - The legacy adapter checks a receipt before dispatching and records one
    after a successful publish.
  - The order is deliberately check → dispatch → record. A crash between
    dispatch and record leaves no receipt, so the next attempt may dispatch
    again — that is the uncertain-outcome case, and it fails rather than
    reporting success. A failed dispatch records nothing, so a legitimate later
    retry is never suppressed.

### Documentation

- `docs/connectors.md` — the receipt, documented as rule 4 of the contract.

### Breaking Changes

None.

### Migration Notes

`0009_publish_receipts` creates one table and alters nothing:

```bash
npx drizzle-kit push        # or: pnpm exec drizzle-kit migrate
```

Receipts are never expired. That is intentional: the table grows only with
distinct step keys, a stale receipt is harmless, and a deleted one is a double
post.


## [0.4.0] — 2026-09-27

Multi-Account Connections. Connection and Account are now separate entities
(ADR-006), and connecting a second account on a platform no longer destroys the
first.

### Features

- **`connections` and `accounts` tables** — a grant is a connection; an identity
  is an account. One grant can reach several accounts (a Facebook login covering
  several Pages), and one platform can have several grants (two X logins). The
  v0.1.0 model had no way to express either.
- **`account_key` (`platform:handle`)** — the stable reference a Goal, a plan
  step, and `post_targets` all use. Unique per user, so "which account is this?"
  is answerable exactly.
- **`registerConnection()`** — the single write path for a grant and the accounts
  it reaches. Idempotent per identity: a reconnect updates the account in place
  and repoints it at the fresh grant, so its id stays stable and the v0.1.0
  duplicate-row problem cannot recur.
- **Granular disconnect** — `disconnectAccount` removes one account and drops the
  grant only if it was that grant's last account, so removing a single Facebook
  Page does not revoke the login covering two others.
- **Per-account enable/disable** — user intent, separate from health. A disabled
  account is refused by plan validation with `account_disabled` rather than
  silently dropped from a run, and disabling one account never affects others on
  the same platform.
- **Per-account capabilities** — narrower than the platform's set, because a
  Facebook profile and a Page are not the same account type. Connect-only
  platforms resolve to an empty set, so they stay visible and selectable-free.
- **`listAccountsNeedingAttention()`** — surfaces accounts whose grant is
  expired or tokenless, as distinct from disabled ones.
- **Async account resolver** — the Runtime can now resolve *which* account a
  step targets through the accounts table, rather than reading the platform off
  an account key.

### Bug Fixes

- **Connecting a second account on a platform deleted the first.** Both OAuth
  callbacks ran `DELETE FROM social_accounts WHERE user_id = ? AND platform = ?`
  before inserting. This was not "the newest connection wins" — the earlier
  account was destroyed outright. `registerConnection()` never deletes.
- **Reconnecting appended duplicate rows.** `social_accounts` had no unique
  constraint on `(user_id, platform, platform_account_id)`, so repeated connects
  accumulated rows for accounts the user no longer intended to keep, and the
  publish path could select a stale one.
- **Cross-tenant access is refused in the query.** Every account read and write
  takes `userId` and filters on it, so one user's account key cannot resolve to
  another user's account even though the key text is identical.

### Documentation

- `docs/accounts.md` — the account model, `account_key`, enable-vs-health, and
  per-account capabilities
- `docs/connections.md` — grants, why they are not unique per platform,
  registering and disconnecting
- `docs/runtime.md`, `docs/execution.md`, `docs/goals.md` — unchanged in v0.4.0

### Breaking Changes

None. No existing behaviour changed. The five publishers and the v0.1.0 publish
path are untouched.

### Migration Notes

`0008_accounts_and_connections` creates `connections`, `accounts`, and
`post_targets`, and **backfills** them. It alters and drops nothing.

```bash
npx drizzle-kit push        # or: pnpm exec drizzle-kit migrate
```

Backfill behaviour worth knowing:

- Each `social_accounts` row becomes one connection plus the one account it
  identified, **reusing the same ids** so a rollback needs no re-derivation.
- Accounts with no `username` fall back to the platform account id for their
  `account_key` rather than producing a bare `x:`.
- Pre-existing duplicate handles are disambiguated with a `#<row id>` suffix so
  the new unique index still holds.
- `posts.platforms` is split on commas into `post_targets`; empty entries are
  skipped rather than becoming phantom targets that plan validation would reject.

**`social_accounts` and `posts.platforms` remain authoritative** for the v0.1.0
publish path through v0.4.x, and are contracted in **v0.5.0**. The OAuth
callbacks still write to `social_accounts` for the same reason — switching them
to `registerConnection()` happens in the same release that drops the columns, so
the old and new writers are never live at the same time.


## [0.3.0] — 2026-09-27

Runtime Foundation. The Runtime now exists and can execute a Goal end to end:
the durable queue is wired, a run is claimed idempotently, each step dispatches
through the connector contract, and the outcome is recorded as history.

### Features

- **Durable execution on Inngest** (ADR-001). Replaces the once-per-day Vercel
  cron as the execution substrate. Chosen because Phase 6 approval suspension is
  a first-class queue primitive here rather than a hand-rolled state machine.
  Served at `/api/inngest`; authenticated by the SDK's signature check.
- **Goal, Run, Step, and event persistence** — migration `0007`, fully additive.
  `runs.idempotency_key` is UNIQUE, which is what makes an at-least-once queue
  safe; a redelivery is absorbed by the constraint rather than by a
  read-then-write race.
- **Execution state machine** — `pending`, `running`, `awaiting_approval`,
  `completed`, `failed`, `cancelled`, with an explicit transition table tested
  exhaustively across every state and event. `awaiting_approval` is a
  suspension, so a waiting run is neither reclaimed as a stale lease nor
  reported as executing.
- **Plan validation gate** — rejects unknown capabilities, missing targets,
  unknown or disabled accounts, connect-only platforms, and policy-forbidden
  steps *before the first step runs*. Without it, a plan targeting X and
  LinkedIn would publish to X and only then discover LinkedIn is impossible.
- **Step executor** — resolves the connector from the target account, forwards
  the derived idempotency key, and returns a typed outcome. Collaborators are
  injected, so the code that can publish to a real account is testable without
  Postgres, a queue, or a network.
- **Run service** — the only writer of execution state. A transition is computed
  from the current state and an event, so history can never disagree with state
  (ADR-003).

### Improvements

- Retry is a decision, not a side effect: the executor reports `shouldRetry` and
  only the queue retries, because only the queue knows its backoff and budget.
- A failing step no longer aborts its siblings. A goal targeting three accounts
  publishes to the two that work and reports the one that does not — matching
  the "settle each target independently" rule the v0.1.0 composer follows.
- An unclassified failure is treated as **non-retryable**. The dispatch may
  already have reached the platform, so the run fails and the uncertainty is
  recorded for human verification, mirroring `dispatch_started_at` in the
  existing scheduler.
- `target_unavailable` added to the connector error taxonomy: "Chat not found"
  and "X not connected" both need a user action but are different actions — the
  grant is fine and only the account behind it is gone.

### Bug Fixes

- **CI could never have passed on a clean checkout.** The typecheck step ran
  before any build, so `LayoutProps` — a Next 16 generated type — was
  unresolvable and `tsconfig` includes gitignored `.next` paths. The local
  typecheck only passed because a previous `next dev` had left the generated
  types in place. Fixed with a `next typegen` step, verified by deleting
  `.next` and `next-env.d.ts` and reproducing the failure (exit 2) before the
  fix (exit 0).
- **A failing test was masked locally.** `request-origin.test.ts` failed whenever
  `.env.local` defined `APP_URL`, because Vitest loads it and `originFromHeaders`
  correctly prefers it over request headers. Isolated with `vi.stubEnv`, plus a
  new case asserting a spoofed `Host` header cannot move the expected origin
  when `APP_URL` is set.

### Documentation

- `docs/runtime.md` — execution model, queue choice, configuration, idempotency
  and failure policy, observability.
- `docs/execution.md` — the state machine, the step loop, and what the executor
  refuses before dispatching.
- `docs/goals.md` — the Goal record and the three decisions that constrain it.
- `docs/connectors.md` — the connector contract and its four rules.
- `docs/security.md` — secret inventory and rotation runbook.
- `docs/releasing.md` — the per-phase release procedure.

### Breaking Changes

None. No existing behaviour changed: the five working publishers are untouched,
and the connector adapter is additive — nothing calls it yet.

### Migration Notes

Migration `0007_runtime_foundation` creates four new tables and alters nothing
existing. Apply with `npx drizzle-kit push` or `pnpm exec drizzle-kit migrate`.

Two new optional variables, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`, are
required **only** for goal execution. The signing key must be set wherever
`/api/inngest` is exposed, or that route accepts requests from anyone. Without
either, the rest of the application is unaffected.


## [0.2.0] — 2026-09-27

Architecture Foundation. Documentation-only release: no application behavior
changed.

### What's New

Hilbras Studio is repositioned as a **Goal-Driven AI Runtime**. The release
establishes the architectural foundation for the v0.1.0 → v1.0.0 transition:
users will define *what they want to accomplish*, and the Runtime will plan and
execute it using AI, tools, platform connections, accounts, schedules, and human
approvals.

### Features

- `docs/architecture.md` — the layered architecture: Studio UI, Interface,
  Services/Domain, Runtime, Connectors, Accounts & Connections, AI Layer, Tools,
  and Infrastructure, with an explicit contract and dependency rule per layer.
- A keep / refactor / retire inventory of the entire v0.1.0 codebase, so later
  phases know what is finished and what is technical debt.
- The v1.0 Runtime data model, the Connection/Account split, and the end-to-end
  execution flow.

### Architecture decisions

- **ADR-001** — Durable execution uses a managed queue (**Inngest**) rather than
  Vercel Cron, a self-hosted worker, or status quo. Phase 6 approval suspension
  is the deciding factor: waiting hours or days for a human is a first-class
  queue primitive, not a hand-rolled state machine.
- **ADR-002** — The Connector/Capability interface is defined in **Phase 1**, not
  Phase 3, and the five existing publishers are wrapped immediately. This avoids
  building the Runtime against a seam that Phase 3 would have to replace.
- **ADR-003** — Execution state is server-authoritative, extending the existing
  rule for publish results to all Runtime state.
- **ADR-004** — Server actions stay thin; invariants live in server-only services.
- **ADR-005** — Every side-effecting step is idempotent, since the queue retries
  automatically.
- **ADR-006** — `Account` and `Connection` become separate entities, replacing
  today's conflated `social_accounts` row.
- **ADR-007** — Semantic Versioning with a per-phase release gate; v0.x minor
  bumps may break, v1.0.0 begins the stability promise.

### Documentation

- `CHANGELOG.md` created, backfilled through v0.1.0 in Keep a Changelog format.
- `README.md` reframed around the Runtime, with the version ladder and a
  capabilities section describing what actually works today.
- `ROADMAP.md` rewritten for the v0.1.0 → v1.0.0 plan. The previous v0.1.0
  roadmap is preserved in the git history and referenced as superseded.
- Open questions recorded in `docs/architecture.md` §6 — notably that LinkedIn
  is `connect_only` today while the v1.0 flagship example publishes to it.

### Breaking Changes

None. No application code, schema, or configuration changed in this release.


## [0.1.0] — 2026-09-24

The first working release. A social media management platform that connects
accounts and publishes AI-assisted content. This is the baseline the
Goal-Driven AI Runtime roadmap builds on.

### Features

- **Authentication** — email/username sign-in and sign-up, bcrypt password
  hashing, HS256 JWT sessions in httpOnly cookies with a 7-day sliding window.
- **Session revocation** — tokens carry `token_version`; bumping the column
  invalidates every outstanding cookie at once.
- **Sign-in lockout** — per-account failed-attempt counter with a lockout
  window, plus an in-memory burst throttle on auth form posts.
- **Signup policy** — deployments can disable public registration or require a
  `SIGNUP_INVITE_CODE`.
- **Platform connections** — OAuth for Instagram, Facebook, Threads, X,
  LinkedIn, TikTok, YouTube, Pinterest, and Reddit; manual bot-token
  connection for Telegram. Per-user client credentials are stored encrypted and
  override the environment variables.
- **AI content generation** — any OpenAI-compatible or Anthropic-compatible
  provider (OpenRouter, Groq, Together, …), plus a server-configured built-in
  "Hilbras AI" model that users can select but not edit.
- **Smart Composer** — AI rewrites content against the selected platforms'
  length limits and content rules.
- **Post scheduler** — queue posts for scheduled publishing, with a manual
  "Publish due now" trigger alongside the daily Vercel cron.
- **Assistant** — streaming chat with persistent sessions, rolling context
  summaries, and long-term memory extraction.
- **Inbox** — X mentions and Instagram conversations.
- **Analytics** — publishing outcomes and weekly activity, backed by real data.
- **Media uploads** — images stored as bytea and served from `GET /api/media/[id]`,
  giving Meta's publish endpoints a durable public URL.
- **Dark mode** — full light/dark theming.
- **Public documentation site** — in-app guides under `/docs`.

### Security

- AES-256-GCM encryption for all stored tokens and credentials at rest.
- SSRF hardening: DNS-pinned provider fetches with manual redirect handling,
  no-store policy, bounded timeouts, response-size limits, and private/unsupported
  address blocking.
- Baseline security headers on every response, including a Content Security
  Policy that permits `unsafe-eval` in development only.
- Credential responses are write-only and preserve existing secrets on edit;
  the credential writer was moved to a server-only module.
- Same-origin enforcement on manual scheduler triggers, with a secret-only
  `GET` cron path that fails closed without `CRON_SECRET`.
- `safeReturnPath` collapses untrusted redirect targets to local paths,
  preventing open redirects through the OAuth callback.
- Dependency upgrades and OAuth header hardening.

### Reliability

- Scheduler claim/lease with owner IDs, a 5-minute lease, conditional
  finalization, a 100s run deadline, and a 60s per-post provider timeout.
- Uncertain-outcome handling: a crash or hang after dispatch is failed with an
  explicit "verify before retrying" result and is never blindly retried.
- Per-user and deployment-wide AI spend budgets with input/output limits and
  fail-closed limiter errors, covering every model entry point.

### Testing and CI

- Vitest with 42 unit tests and 14 PostgreSQL integration tests
  (Testcontainers).
- GitHub Actions pipeline running lint, typecheck, unit tests, integration
  tests, production build, migration validation, and a dependency audit.

[Unreleased]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.9.5...v0.10.0
[0.9.5]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.9.0...v0.9.5
[0.9.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hilbras/Hilbras-Studio/releases/tag/v0.1.0
