# Changelog

All notable changes to Hilbras Studio are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 minor versions may contain breaking changes — see
[ADR-007](docs/architecture.md#adr-007--semantic-versioning-with-a-per-phase-release-gate).

Tags are `vX.Y.Z`, created only from a green CI run on `main`.

## [Unreleased]

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

[Unreleased]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hilbras/Hilbras-Studio/releases/tag/v0.1.0

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

[Unreleased]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Hilbras/Hilbras-Studio/releases/tag/v0.1.0

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

[Unreleased]: https://github.com/Hilbras/Hilbras-Studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hilbras/Hilbras-Studio/releases/tag/v0.1.0
