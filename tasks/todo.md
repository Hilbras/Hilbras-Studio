# Hilbras Studio Remediation Tasks

Source plan: [`tasks/plan.md`](./plan.md)

## Current Progress

- Task 1 foundation: Vitest, CI workflow, 42 unit tests, and 4 disposable-PostgreSQL integration tests are in place.
- Task 2 first increment: strict local schedule parsing and draft-save failure guards prevent accidental immediate publishing.
- Task 3 first increment: centralized publishing capabilities gate Composer/Accounts and align public docs.
- Task 6 first increment: platform credential responses are write-only and preserve existing secrets during edits.
- The user-ID-scoped credential writer now lives in a server-only module rather than the browser-callable action module; integration coverage verifies replacement, tenant separation, and redacted status DTOs.
- Task 4 first increment: centralized per-user/deployment AI budgets cover Assistant, Composer, inbox suggestions, provider pings, summaries, and memory extraction; input/output limits and fail-closed limiter errors are added.
- Task 5 first increment: user-configured AI provider fetches use a DNS-pinned transport with manual redirects, no-store policy, bounded timeouts, and response-size limits; address/URL guard tests cover private and unsupported targets.
- Credential and AI-budget integration coverage now verifies write-only secret replacement/preservation, tenant separation, redacted status DTOs, and both per-user and deployment-wide limiter exhaustion against disposable PostgreSQL.
- Signup controls: deployments can disable public registration or require `SIGNUP_INVITE_CODE`; the UI accepts an optional invite field and tests cover the policy.
- Current verification: 42 unit tests, 14 PostgreSQL integration tests (4 database + 10 scheduler), typecheck, lint (0 errors/26 warnings), production build, frozen install, and dependency audit all pass.
- Task 7 first increment: cron `GET` is secret-only and fails closed without `CRON_SECRET`; manual runs use an authenticated same-origin `POST`, with route coverage for missing/wrong secrets, cross-origin rejection, and session scoping.
- Task 7 first increment: Composer persists connector results through a server action, so the client no longer submits terminal success flags or result URLs; multi-platform publishing settles each target independently.
- Task 10 done: scheduled posts now use claim owner IDs with a 5-minute lease, conditional finalization, a 100s run deadline, a 60s per-post provider timeout under a 120s route `maxDuration`, and uncertain-outcome handling (post-dispatch crashes and hangs are failed with an explicit "verify before retrying" result, never blindly retried). Ten integration tests cover overlap, lease ownership, stale/legacy recovery, deadline, timeout, and partial/all-failure results.

## Phase 0: Safety Baseline

- [ ] **Task 0 — Inventory and rotate local secrets**

  Treat the populated local environment as potentially exposed, restrict permissions, document rotation/reconnect consequences, and scan tracked history without copying secret values. **Depends on:** none.

- [x] **Task 1 — Establish test and CI foundations**

  Add test/typecheck/quality scripts, a test stack, mocked external boundaries, and CI gates. **Depends on:** none. **Checkpoint:** tests, typecheck, lint, build, migration check, and audit run from a clean checkout.

- [x] **Task 2 — Fix Composer scheduling and save-state transitions**

  Require valid schedule input, stop on save errors, and separate draft/scheduled/immediate states. **Depends on:** Task 1.

- [x] **Task 3 — Define and enforce platform capabilities**

  Separate connectable/publishable/media/account/token capabilities and align Accounts, Composer, scheduler, and docs. **Depends on:** Task 1.

- [x] **Task 4 — Add global AI spend and request limits**

  Cover every model entry point, summaries, memory extraction, provider pings, input/output limits, and public signup controls. **Depends on:** Task 1.

- [x] **Task 5 — Harden provider URL fetching against SSRF**

  Enforce safe schemes/IP ranges, redirect policy, DNS pinning/egress filtering, timeouts, and response limits. **Depends on:** Task 1.

- [x] **Task 6 — Remove platform secrets from browser responses**

  Return presence/masked DTOs only; secrets are write-only from the client boundary, and the user-ID-scoped writer is server-only. **Depends on:** Task 1.

- [ ] **Task 7 — Make cron/manual publishing CSRF-safe and server-authoritative**

  First increment is in place: `GET` is secret-only and fails closed when `CRON_SECRET` is absent; manual runs use an authenticated same-origin `POST`. Composer persistence uses the server-produced connector outcome rather than a client-supplied success flag or result URL. Lease/deadline recovery and replay coverage are tracked under Task 10. **Depends on:** Tasks 1 and 6.

- [ ] **Task 8 — Implement truthful account export and deletion**

  Define tenant data scope, implement export/deletion, and align Meta callbacks/privacy/retention behavior. **Depends on:** Tasks 1 and 7; requires a database design decision.

### Checkpoint: Safety Baseline

- [x] P1 security/correctness fixes have focused tests.
- [x] No decrypted secrets appear in client responses.
- [x] No client request can trigger an unintended scheduled publish.
- [x] Provider URLs and model spend are bounded.
- [ ] Account deletion/export behavior is approved.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.

## Phase 1: Reliability and Data Integrity

- [ ] **Task 9 — Build and test the OAuth provider matrix**

  Implement/test token method, auth style, PKCE, scopes, response parsing, profile lookup, and refresh lifecycle per provider. **Depends on:** Tasks 1, 3, and 5.

- [x] **Task 10 — Add scheduler leases, time budgets, and idempotency**

  Add claim ownership/attempt IDs, elapsed-time limits, conditional finalization, and uncertain-side-effect handling. **Depends on:** Tasks 1, 3, and 7.

- [x] **Task 11 — Make multi-platform publishing settle independently**

  `Promise.allSettled` preserves successful platform outcomes when another connector rejects; Composer now persists the server-produced result in one authenticated action; the scheduler settles and finalizes under Task 10's claim model. **Depends on:** Tasks 7 and 10.

- [ ] **Task 12 — Add database constraints, indexes, and tenant defense-in-depth**

  Add safe constraints/indexes/RLS or documented app isolation, and make connection/provider writes transactional. **Depends on:** Tasks 8–10.

- [ ] **Task 13 — Standardize timezones and external HTTP behavior**

  Establish timestamp semantics and shared timeout/cancellation/redirect/response-bound policies. **Depends on:** Tasks 4, 5, and 10.

- [ ] **Task 14 — Correct analytics, inbox, and preference behavior**

  Use actual result data, match inbox support to implementation, persist read/error state, and implement or remove inert preferences. **Depends on:** Tasks 1, 3, and 11.

### Checkpoint: Reliability and Data Integrity

- [ ] OAuth contracts and refresh behavior are tested.
- [ ] Scheduler claims, timeouts, and duplicate behavior are tested.
- [ ] Database constraints and tenant isolation are verified.
- [ ] Timezone and external HTTP behavior are bounded.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and migration checks pass.

## Phase 2: Cleanup and Refactoring

- [ ] **Task 15 — Remove confirmed dead code and dependencies**

  Remove checked source/action/export/dependency residue; retain migrations, Proxy, templates, callbacks, and write-only schema fields. **Depends on:** Tasks 1–14 sufficiently stabilized.

- [ ] **Task 16 — Rewrite documentation and product claims**

  Align roadmap, README, setup docs, pricing, privacy, platform claims, and environment instructions with verified code. **Depends on:** Tasks 3, 8, 9, and 14.

- [ ] **Task 17 — Extract server data and publishing boundaries**

  Introduce a server-only DAL, typed connector contract, shared HTTP policy, and feature-level client splits without bulk rewrite. **Depends on:** Tasks 9–14. **Note:** split into multiple PRs before implementation.

- [ ] **Task 18 — Add observability, performance, and accessibility guardrails**

  Add structured metrics/logging, query/bundle/Core Web Vitals baselines, CI checks, and critical browser accessibility coverage. **Depends on:** Tasks 1, 13, and 16.

### Checkpoint: Release Readiness

- [ ] All P1 findings are closed or explicitly accepted.
- [ ] P2 findings have owners and dates or documented risk acceptance.
- [ ] Dead-code decisions are recorded.
- [ ] Documentation, environment, migrations, and deployment configuration agree.
- [ ] Clean-checkout test, lint, typecheck, build, migration, audit, and browser gates pass.

## Per-Task Completion Checklist

- [ ] Focused tests added or updated.
- [ ] Acceptance criteria in `tasks/plan.md` are satisfied.
- [ ] Verification commands pass.
- [ ] Database changes include migration verification and repair/rollback notes.
- [ ] External API changes include mocked and, where possible, sandbox verification.
- [ ] User-facing behavior and documentation are updated together.
- [ ] No unrelated cleanup is included.
