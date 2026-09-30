# Hilbras Studio Remediation Tasks

Source plan: [`tasks/plan.md`](./plan.md)

> **Re-baselined 2026-09-29** against the current codebase (Phase 8 / v0.9.5,
> commit `e8d2340`). The rebuild into the Goal-Driven AI Runtime (Phases 3–8)
> landed after the last update below; a full five-agent audit re-verified every
> task against the live code. This file is now the authoritative per-item
> status; plan.md keeps the historical acceptance criteria. Baseline at
> re-baseline time: 421 unit tests green, typecheck/lint/build green.

## Verified status (audit 2026-09-29)

| Task | Verdict | Evidence / remaining gap |
|---|---|---|
| 0 Secrets inventory | Open (operational) | Nothing implemented; requires owner action, no code change. |
| 1 Test/CI foundations | **Done** | `.github/workflows/ci.yml` runs install→lint→typegen→typecheck→unit→integration→build→migration check→audit. 455 unit tests + a 179-test Testcontainers integration suite (15 files). Only gap: analytics untested. |
| 2 Composer scheduling | **Done** | `composer/page.tsx` blocks invalid schedules; `posts/service.ts` single-transaction draft/scheduled; `actions/publish.ts` publishes only `status="draft"`. |
| 3 Platform capabilities | Partial | Capability registry + Composer gating + server-side refusal verified. **2026-09-29: exact-count contract test added (5 publishers / 5 connect-only).** Remaining: `mediaTypes` not in the capability contract; `createPostAction` has no server-side validation (gating is client-side; server still refuses at publish time). |
| 4 AI spend limits | **Done** | All model entry points budgeted (assistant, composer, runtime planner/compose/tools, pings, summaries, memory); fail-closed; signup policy. Gap: no test for limiter DB-failure path. |
| 5 SSRF hardening | **Done** | `net-guard.ts` blocks private/metadata/CGNAT ranges (v4+v6); DNS-pinned transport, manual redirects, 1 MiB cap; dev bypass was removed entirely (plan's "gate it" wording is obsolete). **2026-09-29: TEST-NET-1/2/3, 192.0.0.0/24, multicast/broadcast ranges added with tests.** |
| 6 Secrets write-only | **Done** | Server-only stores; blank-secret preserves; masked/presence DTOs only; tenant-separation tests. |
| 7 CSRF-safe publishing | Partial → **URL gap closed 2026-09-29** | Secret-only GET (fails closed), same-origin POST, server-authoritative finalization, full route tests. **2026-09-29: every result URL is now validated server-side (`src/lib/result-url.ts` — https + per-platform host allowlist) at all five permalink construction sites and both result funnels (`publishForUser`, `publishToAllForUser`), with unit tests.** Remaining: an action-level fabricated-outcome test is mitigated by the zod-stripped action inputs, the guarded conditional update (`eq(status, "draft")`), and the funnel sanitization tests; a dedicated integration test would still be nice. |
| 8 Export & deletion | **Done (self-serve, 2026-09-29)** | `src/lib/account-lifecycle.ts` enumerates every table the user id reaches; export route `/api/account/export` produces one JSON document with secrets reduced to presence flags; `deleteAccountAction` (password-confirmed) deletes the `rate_limits` rows keyed with the user id plus the user row — cascades remove the rest — in one transaction. Settings → Data & account exposes both. Two-tenant export/deletion integration tests; privacy page updated to match. Remaining (operator): Threads-only Meta deletion callback unchanged; retention/backup runbook is a deployment decision. |
| 9 OAuth matrix | **Done (2026-09-29)** | Signed state verified; Facebook GET vs Meta POST separated; Instagram/Threads refresh implemented. **2026-09-29: X and Reddit exchange via HTTP Basic (secret never in the body); profile lookups for X/Reddit/LinkedIn/TikTok/YouTube/Pinterest with per-provider contract tests — an unresolvable profile fails the connect (`profile_unavailable`) instead of storing a colliding `"unknown"` id; PKCE issued for every flow whose exchange can carry a verifier (Facebook's GET flow gets none, per its documented parameters; the dead `usesPkce` flag was removed and the policy documented); X's rotating refresh token is refreshed by the cron maintainer (rotation contract tested); callback route contract tests pin the exchange/profile shapes.** Remaining (operator): sandbox verification per live provider. |
| 10 Scheduler leases | **Done** | Claim/lease (5 min), 100s deadline, 60s per-post timeout under 120s route maxDuration, uncertain-outcome handling, 10 integration tests + Inngest run-idempotency tests. |
| 11 Independent settlement | Partial core done → **remaining items closed 2026-09-29** | `Promise.allSettled`, shared server-side transitions, receipts. **2026-09-29: connector results validated server-side (URL host allowlist, bounded text, `success === true` strictness — `sanitizePublishResult`); composer-path all-failure, timeout, and sanitization tests added to `publish.test.ts`.** Remaining (minor): an analytics/Composer display-parity test. |
| 12 DB constraints | Partial → **core constraints added 2026-09-29** | Uniqueness/indexes/tenant isolation (documented app-only branch) verified on the new schema. **2026-09-29: migration 0014 adds a CHECK on `posts.status` (five terminal states) and a partial unique index enforcing one default `ai_providers` row per user, both integration-tested; `registerConnection`, provider selection, and the provider save path are now transactional.** **2026-09-30: migration 0017 adds the four remaining state checks** — `runs.state` and `run_steps.state` (the six `EXECUTION_STATES`), `run_step_approvals.state` (`pending`/`approved`/`rejected`/`expired`), and `goals.status` (`active`/`paused`/`archived`). Generated by drizzle-kit from the schema, so the journal and snapshot are consistent by construction. The goal check has a second job beyond consistency: `goals_due_idx` is a partial index on `next_firing_at WHERE status = 'active'`, and it stops matching any row in a status it does not name — so a fourth status would not break the index, it would make the scheduler quietly stop firing goals in that state. The test rejects `"succeeded"` on `runs.state` specifically: that word is real in this codebase as a `GoalHealth` computed in `goals/service.ts`, so a writer reaching for the wrong vocabulary would otherwise be indistinguishable from a correct one. **Verified by mutation:** emptying the migration fails exactly the new test and leaves the other five in the file green. **2026-09-30: the EXPLAIN evidence is now a test, not a pasted table** — `tests/integration/index-plans.test.ts` seeds 4,000 goals and 4,000 approvals and asserts the two hot queries are *eligible* for `goals_due_idx` and `run_step_approvals_pending_expiry_idx` by plan shape, against the real schema on every integration run. Asserting the **index name** is the point: a partial index is invisible to the planner unless the query's predicate implies the partial one, so a future edit that widens the predicate stops the index being a candidate and the sweeper degrades to a full scan on a table that only grows — the query still returns the right rows, just slowly, and nothing else in the suite notices. A test demonstrates that failure mode directly: drop `state = 'pending'` and the index stops being a candidate while the query stays correct. The limits are recorded in the file: it does **not** prove production-volume performance, and at 4,000 rows PostgreSQL seq-scans anyway, so dropping the indexes fails the two eligibility tests and leaves the row-count tests green. A production `EXPLAIN (ANALYZE, BUFFERS)` remains an operator step. |
| 13 Timezones/HTTP | **Done (2026-09-29)** | Goals use `timestamptz` + DST-tested cron; single HTTP funnel (`http.test.ts` enforces no raw `fetch`); `fetchWithTimeout` does not follow redirects and bounds every response body at 2 MiB inside the total deadline; the assistant stream cancels upstream generation on client disconnect. **Migration 0016 converts all 33 remaining bare `timestamp` columns to `timestamptz` with explicit `AT TIME ZONE 'UTC'` casts** — one timestamp contract, so the scheduler, claim-lease, and rate-limit comparisons no longer depend on the server's timezone. This **reverses the deferral recorded twice above** (Task 13 previously read "`posts.scheduled_at` is a bare `timestamp` … needs a deliberate data decision"); that decision and its UTC precondition are now in the 0016 migration note. **Corrected 2026-09-29:** this row previously claimed 0016 was "verified by the full integration suite", which was not true — the suite applied 0016 and asserted nothing about it. `tests/integration/timestamptz-migration.test.ts` now stages the journal at 0015, writes a row through the pre-0016 schema, applies the real 0016, and asserts the instant is preserved and the session-dependence is gone; two drift guards read the migration file so a lost `AT TIME ZONE 'UTC'` fails in CI. Both were confirmed to fail against a deliberately wrong zone. Remaining: connect-phase timeout distinct from the total deadline (low value). |
| 14 Analytics/inbox/prefs | **Done (2026-09-29, one recorded scope decision)** | Analytics reads real results incl. partial success; query bounded (`.limit(500)`); a failed provider fetch is reported per platform ("X: …") instead of reading as an empty inbox. **2026-09-29: inbox read state persists (`inbox_read_state` table, 30-day pruning, per-message `markInboxRead` action, unread count survives reloads); the four inert preference toggles are removed from the UI — none changed behavior, and a toggle that does nothing is a false claim (columns retained in schema, documented for reintroduction). Goal-run publishes in the analytics dashboard are recorded OUT OF SCOPE: receipts record successes only, so merging them into a published/failed split would distort the stats, and run outcomes are already visible in the Runs view — revisit only if the dashboard gains a runtime section.** |
| 15 Dead code | **Final sweep done 2026-09-30 — Task 15 CLOSED** | **`src/lib/mock-data.ts` deleted and four unused dependencies removed (2026-09-29). 2026-09-30: the final reference-checked sweep, the item the plan ordered last on purpose.** Rather than grep for names, the sweep **resolves the real import graph** — the first attempt did grep, and reported `lib/crypto.ts` and `lib/session.ts` as unreferenced, both of which are imported dozens of times. **Six modules deleted, five kept with a recorded reason.** Deleted: the two `dashboard/*.tsx` files (orphaned behind `/dashboard`, which permanently redirects to `/runtime`); `actions/analytics.ts` and `actions/dashboard.ts` (thin adapters written three commits earlier, whose last caller — the analytics page — had become a server component reading the service directly, so a `"use server"` module with no importer is an endpoint nothing calls); and `actions/credentials.ts` (a generic-credential UI superseded by the per-platform path in `actions/platform.ts` — it carried `server-only`, not `"use server"`, so it was never an RPC endpoint at all). The `stored_credentials` table and its writer are still live and untouched. Kept, in a `KEPT` list in the guard with a reason each: `ui/separator.tsx` and `ui/tabs.tsx` (Radix primitives — a kit is a set, not a set of usages) and three motion primitives unused since v0.1.0, kept as a group so the kit shrinks by decision rather than file-by-file. **New guard:** any production module with neither an importer nor a framework entry point now fails the suite. |
| 16 Docs truthfulness | Partial → **public-facing claims fixed 2026-09-29** | README/platform claims match the registry (done by the rebuild). **2026-09-29: the pricing page no longer quotes unimplemented tiers/trial/seats (now: free while v1 is built, honest capability list); fabricated testimonials removed from the landing page; the CTA no longer claims GDPR compliance; the privacy page now describes the retention/deletion scope that actually exists and marks self-serve export/deletion as roadmap instead of promising it.** Remaining: product-owner sign-off on public claims (not machine-checkable). **2026-09-30: developer-doc path rot fixed, and now guarded.** A sweep of every backticked file path in `README.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/**` and the in-app `src/app/docs/**` found `docs/platform-development.md` still instructing readers to write a publisher in `src/lib/publish.ts` and *linking to it* — a file that has not existed since v0.3.0, when the 975-line module was split into a directory. That is the main onboarding path for adding a platform, so its first instruction sent a new contributor nowhere; the link renders, the build passes, and a reader who does not already know the layout cannot tell it is wrong. The same sweep found the architecture doc's "retire this" table still listing `src/lib/mock-data.ts` as a pending to-do weeks after it was deleted, so the table read as live work. Both corrected, along with two `publish.ts` references in the in-app developer guide. **New `src/docs.test.ts`** fails on any documentation reference to a file that does not exist, with a narrow rule (source extensions only, whole tokens only) so a false positive never argues with the author, and a `HISTORICAL_ALLOWLIST` for deleted files named in records that are still true — a third test fails an allowlist entry whose file exists again, because an unnecessary exception reads as a live one and hides the next stale reference that reuses the name. **Verified by mutation:** pointing the how-to back at `src/lib/publish.ts` fails exactly the missing-file test and leaves the other two green. |
| 17 Boundaries/DAL | **Fourth tranche done 2026-09-30 — Task 17 CLOSED** | **The 975-line `publish.ts` is now `src/lib/publish/`** (tranche 1); `actions/ai` and `ai-providers` are thin adapters over server-only services (tranche 2); `src/lib/ai.ts` is split by concern behind its unchanged barrel (tranche 2). **Tranche 3 — the last cross-layer import is closed.** The dashboard *and* analytics reads moved out of the `"use server"` modules into the server-only, owner-scoped `src/lib/dashboard/queries.ts`, every one taking a `userId` in the `WHERE` clause per ADR-008. The blocker was not the import path but the **ambient session**: each reader resolved the session itself, which made them unusable by the Assistant's context builder, the caller that needed them. `buildAssistantSystemPrompt` now resolves the session once and passes `user.id` explicitly, and the analytics page reads the service directly via `requireSessionUser()`. 19 new integration tests + `scripts/mutate-task17.sh` (21 mutations, 21 covered / 0 holes — it found a real gap in the tests, and its one unreachable filter is documented rather than papered over). **Tranche 4 — DTOs left the `"use server"` modules,** which export RPC endpoints and so cannot own a row's shape: chat DTOs → `src/lib/chat.ts`, inbox DTOs → new `src/lib/inbox/types.ts` (types-only; there is no inbox table), `PostItem` → `src/lib/posts/targets.ts` (the only module that knows a post is a row *plus* its targets). Every action re-exports its types, so no consumer's import changed shape. `PostFormState` and its nine siblings stay — they are `useActionState`'s type for an action's own result, which no service returns. **`src/layers.test.ts` enforces all of it by scanning the tree**, each rule verified to fail against a real injected violation. |
| 18 Observability/a11y | **Third tranche done 2026-09-30** | `src/lib/logger.ts` — one JSON object per line (`ts`, `level`, `event`, flat fields), unit-tested — carries the events the plan names: `publish_run_finished`, `token_request_failed`/`token_rotation_failed`, `ai_budget_denied`, `account_deleted`. `eslint-plugin-jsx-a11y` recommended rules run in `pnpm lint`, which CI enforces. **2026-09-30 — bundle budget.** New `scripts/bundle-budget.mjs`, wired into CI after the build: gzipped first-load JS per prerendered route, failing over 295 KiB total / 82 KiB largest chunk (measured baseline: `/` at 254.1 KiB, largest chunk 69.8 KiB). **It reads the `<script src>` tags out of each route's emitted HTML, not the per-route build manifest** — Turbopack's manifest carries only the shared `rootMainFiles`, identical for all 49 routes, so a budget built from it compares one number with itself; that is how the first draft was wrong. Dynamic (ƒ) routes are reported as unmeasured rather than counted as zero. `--update` re-baselines to measurement **+15%**, verified idempotent, and both thresholds were verified to fail. **2026-09-30 — reduced motion.** 26 components animate through framer-motion and the only reduced-motion handling in the product was one CSS rule for the docs fade, so a visitor whose OS asks for reduced motion still received every JS-driven animation. Fixed with `MotionConfig reducedMotion="user"` in the root provider — one place, above every route. Three static guards keep it wired, each verified to fail when the fix is removed. **2026-09-30 — query-plan evidence** (fourth tranche, closing the Task 12 item this line previously listed as remaining): `tests/integration/index-plans.test.ts` asserts the scheduler's due-goal query and the approvals sweeper are *eligible* for their partial indexes, by seeding 4,000 goals and 4,000 approvals at the real distribution. Asserting the index name is the point — a partial index silently stops being a candidate if a predicate widens, and nothing else in the suite notices. Remaining: **browser-level a11y smoke** (needs `@playwright/test` + a CI browser install — a dependency and workflow decision, not made unilaterally); external-call latency baselines. |

## Work order (re-baselined priority)

1. ~~**Task 7/11 close-out**~~ **done 2026-09-29**.
2. ~~**Task 15 quick wins**~~ **done 2026-09-29**; the **final reference-checked sweep is done 2026-09-30** — six unreachable modules deleted, five kept with recorded reasons, and a guard so residue cannot accumulate unnoticed. **Task 15 CLOSED.**
3. ~~**Task 12** — migration 0014, transactional writes~~ **done 2026-09-29**.
4. ~~**Task 13** — bounded bodies + redirects, disconnect cancellation, one timestamp contract (migration 0016)~~ **done 2026-09-29**.
5. ~~**Task 16 remainder** — pricing/testimonials/privacy claims~~ **done 2026-09-29** (owner sign-off remains).
6. ~~**Task 9** — OAuth provider matrix~~ **done 2026-09-29** (sandbox verification per provider remains with the operator).
7. ~~**Task 14** — read-state persistence, provider errors, preferences removed~~ **done 2026-09-29** (goal-run analytics recorded out of scope).
8. ~~**Task 8** — export + self-serve deletion~~ **done 2026-09-29** (retention/backup runbook remains with the operator).
9. ~~**Task 17** — DAL extraction~~ **tranches 1–4 done 2026-09-30**: the publish boundary, `ai.ts` by concern, the dashboard/analytics owner-scoped read layer, and the DTOs out of the `"use server"` modules (enforced by `src/layers.test.ts` and 21 mutations in `scripts/mutate-task17.sh`). **Task 17 CLOSED.**
10. **Task 18** — observability (four tranches: structured logger, CI bundle budget, reduced motion, and the Task 12 query-plan evidence). Remaining: browser a11y smoke and external-call latency baselines — both operator-owned, and why is stated below.
11. ~~**Task 0**~~ — remains an owner action (secret rotation), no code.

## Migration notes — 0015 (inbox read state) and 0016 (timestamptz)

- **0015** adds `inbox_read_state` (user, platform, message_id unique; cascade
  on user). Additive; no preflight needed. Rollback: `DROP TABLE
  inbox_read_state;`
- **0016** converts all bare `timestamp` columns to `timestamptz` with
  `USING <col> AT TIME ZONE 'UTC'` — existing rows are interpreted as UTC,
  which matches every deployment that runs the app server in UTC (Vercel
  default, containers). **Preflight for self-hosters with a non-UTC server
  timezone:** rows written while the server ran in another timezone render as
  that timezone's wall clock; correct them before migrating, e.g.
  `UPDATE posts SET scheduled_at = scheduled_at AT TIME ZONE '<server tz>';`
  per affected table/column. Rollback: `ALTER COLUMN ... TYPE timestamp
  USING <col> AT TIME ZONE 'UTC'` (loses offset information — schedule
  verification recommended). Verified end-to-end by the integration suite
  (scheduler, goals, rate-limit, and receipt tests all round-trip Dates).

## Migration note — 0014_post_status_check_and_default_provider

- **Verification:** `drizzle-kit check` passes (journal/snapshot consistent); the
  disposable-PostgreSQL integration suite applies the full chain and asserts
  both constraints fire (`tests/integration/database.test.ts` — "enforces the
  post status check and the one-default-provider invariant").
- **Repair note:** applying 0014 to an existing deployment fails if
  `posts.status` holds a value outside the five modeled states, or if any user
  already has two default providers. Preflight: `SELECT status, count(*) FROM
  posts GROUP BY 1;` and `SELECT user_id, count(*) FROM ai_providers WHERE
  is_default GROUP BY 1 HAVING count(*) > 1;`. Repair: rewrite offending rows
  to the nearest modeled state (`queued → draft`) and demote extras to
  non-default before re-running the migration.
- **Rollback:** drop the constraint and index —
  `ALTER TABLE posts DROP CONSTRAINT posts_status_check;`
  `DROP INDEX ai_providers_user_default_unique_idx;`

## Migration note — 0015_inbox_read_state

- **Verification:** applied by the full-chain apply in every integration file;
  `tests/integration/inbox-read-state.test.ts` covers the read/unread
  transition, cross-user isolation (one user's read state never marks another's
  message read), and the `(user_id, platform, message_id)` uniqueness that keeps
  the row count bounded.
- **Preconditions:** none. Additive only — a new table, a new index, and one
  foreign key with `ON DELETE CASCADE`, so removing a user removes their read
  state with them.
- **Repair note:** not applicable; there is no pre-existing data to reconcile.
- **Rollback:** `DROP TABLE inbox_read_state;` — read state is derived, not a
  record of anything, so discarding it costs only unread badges.

## Migration note — 0016_timestamps_to_timestamptz

> **This migration reverses a recorded deferral.** The status table above, and
> the Task 13 row, twice declined this work by name: *"`posts.scheduled_at` is
> a bare `timestamp` (second, undocumented contract) — migrating it to
> `timestamptz` needs a deliberate data decision."* 0016 is that decision, now
> made, and it is recorded here because reversing a deferral is the kind of
> thing that otherwise disappears.

- **What it does:** converts 33 `timestamp` columns to `timestamptz` across 19
  tables. `goals.next_firing_at` was added as `timestamptz` by 0012 and is
  correctly left alone.
- **Verification:** `tests/integration/timestamptz-migration.test.ts` stages the
  journal at 0015, writes a row through the pre-0016 schema, then applies the
  real 0016 and asserts three things: that a bare timestamp *did* resolve to two
  different instants depending on the session (the bug), that the instant is
  unchanged afterwards, and that it no longer depends on the session. Two
  drift guards read the migration file itself — one fails if any conversion
  loses its `AT TIME ZONE 'UTC'`, the other if the schema declares a bare
  timestamp 0016 does not convert. Both were verified to fail on a deliberately
  wrong zone (`Europe/Berlin` shifted the instant by exactly 3600s).
- **⚠️ Preflight — the whole safety of this migration is one precondition.**
  Every conversion uses `USING "col" AT TIME ZONE 'UTC'`, which asserts the
  stored wall-clock *was* UTC and reinterprets it as such. That preserves the
  instant exactly on a database that ran in UTC — Vercel Postgres does. On a
  self-hosted database whose server ran in local time, the same expression
  reinterprets every stored wall-clock as UTC and **silently shifts all of them
  by the offset.** Nothing in the schema can detect this afterwards.
  Preflight: `SHOW timezone;` — if it is not `UTC`/`Etc/UTC`, stop and convert
  with the correct zone instead. Take a backup first regardless.
- **Operational cost:** `ALTER COLUMN ... TYPE` takes `ACCESS EXCLUSIVE` and
  rewrites the table. On `run_events`, `chat_messages`, and `rate_limits` — the
  high-write tables — that is a write outage proportional to table size. Apply
  during a quiet window, and expect it to be the longest step of the deploy.
- **Rollback:** reverting to a bare `timestamp` throws away the zone, and
  `USING "col" AT TIME ZONE current_setting('TimeZone')"` would reinterpret every
  row. There is no safe rollback. If 0016 is applied, it stays applied; take the
  backup beforehand if the conversion itself is in doubt.


## Current Progress

- Task 1 foundation: Vitest, CI workflow, and the disposable-PostgreSQL integration suite are in place; 421 unit tests green at re-baseline.
- Task 2 first increment: strict local schedule parsing and draft-save failure guards prevent accidental immediate publishing.
- Task 3 first increment: centralized publishing capabilities gate Composer/Accounts and align public docs.
- Task 6 first increment: platform credential responses are write-only and preserve existing secrets during edits.
- Task 4 first increment: centralized per-user/deployment AI budgets cover Assistant, Composer, inbox suggestions, provider pings, summaries, and memory extraction; input/output limits and fail-closed limiter errors are added.
- Task 5 first increment: user-configured AI provider fetches use a DNS-pinned transport with manual redirects, no-store policy, bounded timeouts, and response-size limits; address/URL guard tests cover private and unsupported targets.
- Signup controls: deployments can disable public registration or require `SIGNUP_INVITE_CODE`.
- Task 7 first increment: cron `GET` is secret-only and fails closed without `CRON_SECRET`; manual runs use an authenticated same-origin `POST`; Composer persists connector results through a server action.
- Task 10 done: scheduled posts use claim owner IDs with a 5-minute lease, conditional finalization, a 100s run deadline, a 60s per-post provider timeout under a 120s route `maxDuration`, and uncertain-outcome handling. Ten integration tests.
- Task 11 first increment: `Promise.allSettled` settles each target independently; Composer persists the server-produced result in one authenticated action.
- (Historical entries above were preserved from the pre-rebaseline file; per-item status is in the table.)

### Session 2026-09-29 — re-baseline audit + first execution tranche

- Five-audit sweep re-verified all 19 plan tasks against the live code; the
  status table above is the result. Baseline before changes: 421 unit tests,
  0 lint errors, clean typecheck/build.
- Result URLs and result text fields are validated server-side
  (`src/lib/result-url.ts`), wired into `publishForUser`/`publishToAllForUser`
  and all five permalink builders; composer-path all-failure/timeout/sanitization
  tests added. (Tasks 7/11)
- Migration 0014: `posts.status` CHECK + one-default-provider partial unique
  index, integration-tested; `registerConnection`, provider selection, and the
  provider save path wrapped in transactions. (Task 12)
- `fetchWithTimeout`: manual redirects, 2 MiB bounded body inside the total
  deadline; assistant stream cancels upstream generation on disconnect.
  (Task 13)
- Reserved-range additions to `net-guard.ts` (TEST-NET-1/2/3, 192.0.0.0/24,
  multicast/broadcast). (Task 5)
- Dead code removed: `mock-data.ts`, 4 unused dependencies. Analytics query
  bounded at 500 rows. (Tasks 15/14)
- Truthful public claims: pricing page rewritten (no fictional tiers/trial),
  testimonials removed, GDPR claim dropped, privacy page states the actual
  retention/deletion scope. (Task 16)
- Verification after the tranche: **437 unit tests, 169 integration tests,
  typecheck clean, lint 0 errors / 31 warnings, production build green.**
- Deliberately deferred with reasons: `posts.scheduled_at` → `timestamptz`
  (needs a data-semantics decision), X/Reddit basic-auth + OAuth contract
  tests (Task 9, sandbox verification), inbox read-state/preferences (product
  decision), export/deletion (Task 8 design decision), DAL/observability
  (Tasks 17/18, multi-PR).

### Session 2026-09-29 (continued) — work order items 6–8
- **Task 9 complete.** X and Reddit exchange their codes with HTTP Basic
  credentials (`tokenAuth: "basic"` is now consumed; the secret never appears
  in a request body). The six non-Meta OAuth platforms resolve real account
  ids through documented profile endpoints (`src/lib/oauth-profile.ts`), and
  an unresolvable profile fails the connect with `profile_unavailable`
  instead of storing a colliding `"unknown"`. PKCE is issued for every flow
  whose exchange can carry a verifier — Facebook's GET flow, whose documented
  parameters have none, is issued none (the dead `usesPkce` flag is gone).
  X's rotating refresh token is renewed by the cron maintainer. Contract
  tests: `oauth-profile.test.ts`, `platform-tokens.rotation.test.ts`, and
  callback route tests pinning Basic-auth/profile/no-unknown behavior.
- **Task 14 increment.** A failing inbox provider fetch is now reported per
  platform in the UI rather than rendering as an empty inbox.
- **Task 8 complete.** `src/lib/account-lifecycle.ts` is the tenant data
  boundary: `/api/account/export` streams the caller's complete inventory as
  JSON with secrets as presence flags; password-confirmed self-serve deletion
  removes the user plus the `rate_limits` rows its id keys (no FK — deleted
  explicitly in the same transaction; UUIDs carry no LIKE wildcards).
  Settings → Data & account exposes both; two-tenant integration tests prove
  export scoping, secret-freedom, and that deleting one tenant leaves the
  other byte-for-byte intact; the privacy policy now describes exactly this.
- **Verification:** 455 unit tests, 171 integration tests, typecheck clean,
  lint 0 errors, production build green.
- **Remaining for the owner (non-code):** Task 0 secret rotation; sandbox
  verification of each OAuth provider; retention/backup runbook decisions;
  the Task 14 product decisions (read-state, preferences, goal-run
  analytics); Tasks 17/18 are multi-PR work by design.

### Session 2026-09-29 (third) — migrations 0015/0016 made safe to release

This session did not add features. It made two already-written migrations
releasable, because both had landed without the evidence the ledger's own
Definition of Done requires of a database change ("migration verification and
repair/rollback notes").

- **Migration 0015 (`inbox_read_state`)** — already had integration tests; given
  a migration note. Additive, so no preconditions.
- **Migration 0016 (`timestamptz`)** — had **no test at all**, and the status
  table claimed it was "verified by the full integration suite". It was not: the
  suite applied 0016 as part of the chain and asserted nothing about it, so the
  claim was true of the migration existing and false of it being correct. New
  `tests/integration/timestamptz-migration.test.ts` stages the journal at 0015,
  writes a row through the pre-0016 schema, applies the real 0016, and asserts
  that a bare timestamp *did* resolve to different instants per session (the
  bug), that the instant is unchanged afterwards, that `NULL` stays `NULL`, and
  that the already-correct `goals.next_firing_at` is left alone. Two drift guards
  read the migration file itself.
  - Both guards were confirmed to fail on a deliberately wrong zone: swapping
    `UTC` for `Europe/Berlin` on one column failed the drift guard *and* moved the
    stored instant by exactly 3600 seconds.
  - **Precondition, now recorded rather than assumed:** `AT TIME ZONE 'UTC'`
    asserts the stored wall-clock *was* UTC. True on Vercel Postgres. On a
    self-hosted database running a non-UTC server it would silently shift every
    timestamp by the offset, and nothing in the schema could detect it
    afterwards. The 0016 note carries `SHOW timezone;` as a preflight.
  - **No safe rollback** — reverting a `timestamptz` to a bare `timestamp` throws
    the zone away. If applied, it stays applied. Back up first.
- **Corrected a false verification claim** in the Task 13 row rather than leaving
  it standing next to a test that had not existed.
- **Verification:** 455 unit tests, 179 integration tests (15 files), typecheck
  clean, lint 0 errors / 29 warnings, production build green.

### Session 2026-09-29 (third tranche) — Task 14 finished, Phase 1 closed

- **Inbox read state persists.** New `inbox_read_state` table (migration 0015,
  30-day prune-on-write), `markInboxRead` action called when a message is
  opened (optimistically flipped in the UI), unread counts survive reloads.
  Tenant-scoped integration tests; the export inventory includes the new
  table.
- **One timestamp contract (migration 0016).** All 33 bare `timestamp`
  columns are now `timestamptz`, with explicit `AT TIME ZONE 'UTC'` casts so
  existing rows keep their meaning; the scheduler, claim leases, and rate
  limiters no longer depend on the server timezone. Self-hoster preflight
  note recorded above.
- **Preferences resolved per the plan's "implement or remove":** the four
  inert toggles are removed from Settings (they changed nothing; the schema
  columns stay, documented for reintroduction). Goal-run publishes in the
  analytics dashboard recorded **out of scope** with reasoning (receipts are
  success-only; runs view already shows outcomes).
- **Verification:** 455 unit tests, 173 integration tests, typecheck clean,
  lint 0 errors, production build green. **Phase 1 checkpoint closed.**
- What remains: Task 17 (DAL/boundary extraction) and Task 18 (observability,
  a11y, budgets) — both multi-PR by the plan's own instruction — plus the
  owner items above.

## Sessions 2026-09-30 — Tasks 17, 18, and 15

Six tranches, each committed separately. The through-line is that the cheap
check (does the suite pass?) was never the interesting one; the interesting part
was making each claim fail when it should.

### (3rd) Task 17 — the dashboard/analytics read layer

The last recorded cross-layer import is closed. `@/lib` no longer imports
`@/app/` anywhere in the tree.

- **New `src/lib/dashboard/queries.ts`** — server-only, owner-scoped per
  ADR-008; every function takes a `userId` in the `WHERE` clause. The blocker
  was not the import path but the **ambient session**: each reader resolved the
  session itself, so it could not be called by a caller that already knew whose
  data it wanted — which is exactly the Assistant's context builder.
- **Both action modules became thin adapters** that only turn "who is asking"
  into a `userId`; the analytics page (a server component) reads the service
  directly via `requireSessionUser()`.
- **19 integration tests**, two tenants against one database. The ones that
  matter assert on post *content*, not counts: an unscoped read is one tenant's
  drafts in another tenant's screen, and for `getRecentActivity` in their
  conversation too.
- **`scripts/mutate-task17.sh`, 21 mutations, 21 covered / 0 holes.** It found
  a real gap in the tests (a permalink read from a failed result was invisible
  because the fixture's failure carried no URL — two tests added, mutation now
  fails both) and one **provably unreachable** filter: the weekly chart's
  `status = "published"` cannot be distinguished from its date window, because
  every writer sets `publishedAt` only alongside the status. That is documented
  in the script rather than papered over with a fixture violating the writers'
  invariant — the same reasoning `mutate-phase8.sh` records for the
  error-summary guard. Two mutations were also dropped while writing it: a
  duplicate `sed`, and an "unknown" branch whose two sides were identical
  (inert — the exact false pass the harness warns about). One `sed` pattern was
  simply wrong and the `cmp` guard caught it; all 22 were then dry-run against a
  pristine copy before the real run.

### (4th) Task 17 — DTOs out of the `"use server"` modules

The recorded item was "client→action imports". Measuring it first changed the
task: **14 client components import from `@/app/actions`, and almost all of it
is correct** — a client component *calling* an action is the boundary working.
The defect was about types.

- A `"use server"` module's exports are RPC endpoints, so its contract is async
  functions; a DTO declared there is a contract in a module that does not
  describe contracts. Rule: **domain data lives with its service; the action's
  own result shape stays with the action.**
- Moved: chat DTOs → `src/lib/chat.ts`; inbox DTOs → new
  `src/lib/inbox/types.ts` (types-only — no inbox table, so no row to infer);
  `PostItem` → `src/lib/posts/targets.ts` (a post is a row *plus* its targets).
  Every action re-exports its types, so no import changed shape, and the client
  components were repointed too — moving the type while the renderer still
  imported it from the action achieves nothing.
- `PostFormState` and nine siblings **stay**: `useActionState`'s type for an
  action's own result, which no service returns.
- **New `src/layers.test.ts`** — three boundary rules over the tree, plus a test
  that the scanner still *finds* files, so the rules cannot pass vacuously.

### (5th) Task 18 — bundle budget and reduced motion

- **`scripts/bundle-budget.mjs`, in CI after the build.** 295 KiB total /
  82 KiB largest chunk, from a measured baseline plus 15%. It reads the
  `<script src>` tags out of each route's emitted HTML, **not** the per-route
  build manifest: Turbopack's manifest holds only the shared `rootMainFiles`,
  identical for all 49 routes, and the first draft reported an identical 430 KiB
  for every page — a budget on nothing. Dynamic routes are reported as
  *unmeasured*, not as zero. Both thresholds verified to fail; `--update` is
  idempotent and writes measurement **+15%**, because a budget at today's exact
  size fails on the next byte of ordinary growth and teaches re-baselining
  instead of fixing regressions.
- **Reduced motion — a real gap found while scoping the a11y item.** 26
  components animate through framer-motion; the only reduced-motion handling in
  the product was one CSS rule for the docs fade. Fixed with
  `MotionConfig reducedMotion="user"` in the root provider: one line, above
  every route, covering all 26 without touching any. Three guards keep it wired.
- **Browser a11y smoke NOT done, deliberately:** it needs `@playwright/test` plus
  a CI browser install — a dependency and workflow decision, not mine to make
  inside a tranche scoped to two other things. The static guards are the cheap
  half and are honest about their limit: the setting is *wired*, not proven to
  be *obeyed*.

### (6th) Task 15 — the final reference-checked sweep

- **The sweep resolved the import graph instead of grepping for names, and that
  decided the whole result.** The first attempt grepped and reported
  `lib/crypto.ts` and `lib/session.ts` as unreferenced — both imported dozens of
  times. A grep-based sweep is not a weaker version of the real thing; it
  produces a confident wrong answer, and at 105 "findings" it would have been
  very persuasive.
- **Six deleted, five kept with a recorded reason** (two Radix primitives; three
  motion primitives unused since v0.1.0, kept as a group so the kit shrinks by
  decision rather than file-by-file). The two action adapters were **written
  three commits earlier and dead within hours** — which is how this residue
  accumulates, and why the guard matters more than the deletion.
- **New reachability guard**, verified by creating an orphan module.
- **Historical docs annotated, not rewritten.** ADR-004 and the layer table
  record the *original* move of the credential writer; that history is still true
  and the writer is still live, so deleting the record of why a boundary exists
  would be the wrong kind of tidy.

### (7th) Task 12 — EXPLAIN evidence for the two hot-path indexes

The last mechanical item on Task 12, and the one where a pasted `EXPLAIN`
table would have been worthless: it is a claim about a database that no longer
exists. It is now a test against the real schema.

- **`tests/integration/index-plans.test.ts`** seeds 4,000 goals and 4,000
  approvals — the real distribution, where most goals are paused and most
  approvals decided — and asserts the scheduler's due-goal query and the
  approvals sweeper are *eligible* for their partial indexes.
- **Asserting the index name is the whole point.** A partial index is invisible
  to the planner unless the query's own predicate implies the partial one. A
  future edit that widens `status = 'active'` to a set, or drops the `state`
  filter, silently stops the index being a candidate: the query still returns
  the right rows, the sweeper degrades to a full scan on a table that only
  grows, and nothing in the suite, the build, or the linter notices. One test
  demonstrates that failure mode directly rather than describing it.
- **Three of my own mistakes, each caught by a test rather than by reading:**
  the fixture set due goals a minute in the *future*, so the query matched
  nothing — and the index assertion still passed, because a plan over an empty
  result still names the index. Only the row-count assertion caught it, which
  is why both exist. The access-path assertion demanded an `Index Scan` node
  when the planner had correctly chosen a *Bitmap Heap Scan*; asserting the
  relation access path rather than a node name fixed it. And the third was a
  double-wrapped `EXPLAIN`.
- **The mutation run, and the limit it exposed:** dropping both indexes fails
  the two eligibility tests and leaves the row-count and access-path tests
  **green** — at 4,000 rows PostgreSQL prefers a sequential scan either way.
  That is recorded in the file rather than hidden: the eligibility assertions
  carry the weight, and the suite is built so they are the ones that go red.
- **What it does not prove:** production-volume performance. The plan at 10,000
  rows is not the plan at 10 million. A production
  `EXPLAIN (ANALYZE, BUFFERS)` against real data stays an operator step.

### (8th) Publisher failure modes — the gap the docs sweep exposed

`docs/platform-development.md` tells a new platform author to "handle every
documented failure" and warns that a publisher which only handles success makes
every error path report `unknown`, which is non-retryable. That was advice with
nothing behind it: **no publisher had a test file at all**, so the failure
mappings were documentation of an intention rather than a description of
behaviour.

- **`src/lib/publish/publishers.test.ts`, 26 tests.** Each publisher's account
  gate (no HTTP attempt when the account is missing *or* ambiguous — a publisher
  that fetched first would send an unauthenticated request and report a working
  connection as broken), and each platform's own error mapping: a Facebook
  account with no Page, Instagram refusing a text-only publish and a media
  container that returns no id, Threads' length limit and its translation of
  Meta's permission error into the action the user must take, Telegram's empty
  message, and X's platform-supplied message surviving into the result.
- **Two cross-cutting invariants asserted once across all five**, not five times
  each: no result reports success *together with* an error, and every result
  carries its platform name so a failure can be attributed in a multi-target
  publish. Neither is visible from a single platform — it takes a publisher and
  a change elsewhere to violate either.
- **Only the two outbound edges are mocked** — `fetchWithTimeout` and
  `getConnectedAccount`. The publishers, `shared.ts`'s error mapping, and
  `result-url`'s sanitization are all real, so each assertion is about what the
  code does with a given HTTP response. Mocking a publisher's own error mapping
  would only assert that the mock behaves as the mock behaves.
- **Verified by mutation:** letting the account gate fall through to a request
  fails the gate tests, and discarding X's platform error message fails exactly
  that one test with the other 25 green.
- One assertion of mine was wrong rather than the code: Telegram capitalizes the
  platform's `description` and appends the fix, so a case-sensitive
  `toContain` failed against better behaviour than I had assumed. Fixed to a
  case-insensitive match, which is what the test was actually about.
- The how-to now points step 5 at the test file instead of admitting no tests
  exist, and the `<platform>.test.ts` template left the docs guard's
  allowlist — an entry that is no longer needed is worse than none, since it
  hides the next stale reference that reuses the name.

### (9th) A mutation pattern had been broken since Phase 8

Checking whether this series had invalidated the pre-existing harnesses found
that one had. `mutate-phase6.sh` asserted that a step claim is a
compare-and-swap; Phase 8 (`e8d2340`) added the ADR-009 lease clause, which
reformatted the call onto multiple lines, and the `sed` stopped matching.

The harness's own `cmp` guard reports that as SKIP, which counts as a failure —
so CI would have gone red. **What was actually lost is the coverage, silently:**
from Phase 8 onwards, nobody was checking that removing the state predicate
breaks a test, because the harness could no longer perform the removal. The
dangerous direction is the opposite one: a pattern that still matches but no
longer changes behaviour reports "ok" and looks like coverage while checking
nothing, and the `cmp` guard cannot see that.

- **Repaired**, against the current shape, plus a second mutation for the lease
  window itself — the guarantee that was untested alongside the one that was
  nominally covered. `mutate-phase6.sh` now reports **20 covered, 0 holes**,
  including both.
- **New `src/mutation-harness.test.ts`** applies every expression in all four
  harnesses to the file it names, on a temp copy, and requires each to change
  the file. It is the cheap half that makes the expensive half trustworthy, and
  it runs in five seconds rather than the twenty minutes a harness takes — so
  the drift is caught within seconds of landing rather than whenever somebody
  next remembers to run the harness. A named test asserts the compare-and-swap
  and lease mutations are still present, so that one reports by name.
- **Verified by mutation:** restoring the original stale pattern fails the guard
  with a message naming the script, the mutation and the file.
- **One test of mine was wrong, and it was instructive.** I had written a
  "the working tree is clean" assertion to prove the guard did not mutate the
  repository. It failed — because a mutation harness happened to be running
  concurrently and had a file mutated at that instant, which is indistinguishable
  from the test having done it. Removed: such a test is only ever right when no
  harness is running, so it measures the machine's load rather than the code.
  Isolation is structural instead, via the temp copies.

### (10th) Correcting a false enforcement claim, and accounting for the gap

The Phase-8 repair exposed something larger than the broken pattern: **the
mutation harnesses are not in CI at all**, and ADR-008 described them as
"**Enforced, not merely documented**". That is accurate about the technique and
misleading about the timing — nothing ran them automatically, which is precisely
why a dead pattern survived two phases.

- **ADR-008 corrected** to "Enforced, not merely documented — *when the harness
  is run*", with the cost of the choice stated in the ADR itself: the scripts
  take tens of minutes because each mutation starts a Postgres container, so
  they run before a release rather than on every push, and that is how the
  compare-and-swap coverage went missing.
- **`pnpm release:check` now accounts for it.** It reads a date from
  `.mutation-harness-verified` and fails if the tree has changed since. It does
  not run the harnesses — that is the point of the stamp — but a release now
  asserts that the evidence backing its ADR claims was re-derived against the
  code being tagged, which is the half that was missing. A *missing* stamp is a
  warning rather than a failure, so a clean release is not blocked by
  bookkeeping; a *stale* one is a failure.
- **Two things that had to be got right.** The comparison is by calendar date,
  not instant: a stamp is written by hand after a long run, so comparing
  `2026-09-30` against a commit made at 16:52 would call every same-day stamp
  stale and train the reader to write tomorrow's date instead. And the stamp
  file is gitignored — otherwise creating it would fail `release:check`'s own
  "working tree is clean" gate, which is the sort of self-inflicted deadlock
  that makes people skip the check.
- Verified all three paths: today's date is accepted, yesterday's fails, an
  unparseable date fails.
- **v0.11.0 released 2026-09-30.** Alongside the release, the 0017 migration got
  the preflight its own changelog entry had been promising and which did not
  exist: `drizzle/0017_state_checks.preflight.sql`, four SELECT-only queries
  that must each return zero rows. The release notes tell an operator to run it
  before applying 0017, so it cannot be a file that has never been executed.
- **`tests/integration/state-check-migration.test.ts`** — 9 tests. It migrates
  to 0016, inserts, then applies 0017, because a constraint cannot be tested
  from a database that already has it. Beyond refusing bad values it checks the
  other direction — that every value *in* each vocabulary still survives, since
  an over-tight CHECK that refuses valid state would be equally wrong.
- **The preflight is tested as the artefact that ships.** The test reads the SQL
  file off disk rather than restating its queries; a duplicated copy would stay
  green if the file's were wrong. Verified by mutation: deleting a constraint
  from 0017 fails four tests, and a typo in a table name, a typo in a column
  name, and a predicate widened to accept the bad value each fail the
  preflight test. The last is the one that matters — it is how a preflight would
  report "clean" in production while blocking nothing.
- **Two assertions I wrote first were wrong.** Asserting on the constraint *name*
  fails against a correctly-enforcing database, because Drizzle nests the pg
  error under `cause` and the name never reaches `error.message` — so the test
  pushes you toward weakening it. It now asserts SQLSTATE `23514` plus the name
  from the cause chain, which distinguishes "refused for this reason" from a
  fixture that has gone stale. And the last test originally expected the
  re-applied `ALTER TABLE` to succeed; the database refusing to add a CHECK
  over a corrupt row is the entire point of the migration, so it now asserts the
  refusal and then asserts that correcting the row unblocks it.
- **The other two harnesses were then run in full, for the first time in this
  series: `mutate-phase7.sh` reports 16 covered / 0 holes and
  `mutate-phase8.sh` reports 23 covered / 0 holes.** They had been cited in the
  ledger as the enforcement for ADR-008's read layer and for the executor's
  guarantees without anyone confirming they still passed, which is the same
  mistake as the dead pattern one level up: an inherited claim that nobody
  re-derives. The stamp was written afterwards.

### (11th) The 18th integration file broke CI, and it was not a test bug

Pushing v0.11.0 failed CI on `PostgreSQL integration tests` — three `57P01`
`terminating connection due to administrator command` errors attributed to
`account-lifecycle.test.ts`, and **no test summary at all**. The suite was 214/214
green locally.

The failing file is a red herring: `account-lifecycle.test.ts` is in the CI log
with `✓ 2 tests`. Every test passed and the process was killed underneath them.
No summary is the tell — a real assertion failure prints one.

**Cause.** Each integration file starts its own Postgres container in
`beforeAll`, and Vitest defaults to one worker per CPU. Seventeen files had
been at the ceiling; the 18th tipped it, so CI died 50 seconds in. Nothing about
that file was wrong, which is the general shape of this failure: *adding a file
broke the run*, and the error pointed at an unrelated one.

**Fixed** with `maxWorkers: 4` in `vitest.integration.config.mts` — capped
rather than serialized, so the suite stays parallel but the peak is bounded and
the next file added does not reproduce it.

- **Verified by the reproduction that distinguishes the two hypotheses.** Capped
  on a 2-CPU machine (`taskset -c 0,1`, approximating the runner): 18/18 green
  in 222s. Uncapped, the same run **did not finish inside 300s** — which is the
  hang, demonstrated rather than argued.
- Worth recording that memory was the wrong hypothesis: constraining Node to a
  1.5 GB heap still passed 18/18, so it was concurrency, not allocation.

#### …and that diagnosis was also wrong

The cap did **not** fix CI. The second run failed again, and its log is what
finally showed the real thing: **`Test Files 18 passed (18)` / `Tests 214 passed
(214)` — with `Errors 1 error` underneath.** Every test passed *and* the run was
red. The first CI log had no summary at all, which is why I read it as a killed
process; the second run finished normally, which is what made the difference
visible. Concurrency was never the cause; the ceiling story fit "died at 50s" too
well, and I stopped at the first hypothesis that explained the number.

**The actual cause** is `src/db/index.ts` having no `error` listener on its
`Pool`. node-postgres treats an unhandled `error` on a Pool as an uncaught
exception, so one idle client dying takes the process down. A `57P01` arriving
after the tests that used the pool had passed surfaced as an uncaught exception
and failed an otherwise-green run. The listener is now there, logged through the
structured-event helper the rest of the codebase uses.

**This is a production bug, not a CI nuisance.** A server-side idle-connection
close — a proxy timeout, a restart, a failover — would kill the application
process outright rather than being retried. Proved directly rather than asserted:
a two-line probe emitting `error` on a Pool exits 1 with "Unhandled 'error'
event" without a listener, and exits 0 with one. Same probe, both directions.

Not reproduced locally in either form — 3/3 clean solo, and 18/18 green on the
full suite. It is timing- and runner-dependent, which is the kind of defect that
is easiest to misattribute to whatever else is running. The maxWorkers cap is
kept: it is defensible on its own terms and bounds container count, but it is
**not** the fix, and the ledger should not imply otherwise.

**A mistake I made doing this, because the lesson is about the tool.** Testing
the uncapped variant timed out, and the kernel died **before** restoring the
config — so the next call found a config with `maxWorkers` silently removed and
`git status` clean, which is exactly the state where a fix appears never to have
been made. Restored from the backup and re-verified. Restoring state after an
experiment is part of the experiment; a timeout is not a rollback.

### (12th) Auditing the ledger after the release, and what it found

The release prompted a check I had not made: whether the ledger still described
the tree accurately. Two things were stale.

**The work order and the Task 18 line both listed "query-plan evidence for the
Task 12 indexes" as remaining work, while entry (7th) recorded it as done.** I
verified before correcting — `index-plans.test.ts` exists and passes 6/6 — because
the failure mode of this kind of entry is that "done" and "never done" look
identical in a diff. The evidence was real; the summary of what remained was
not. Both corrected to four tranches.

**This is the third stale-claim finding in this series**, after ADR-008's
"enforced, not merely documented" and the two harnesses cited as passing without
anyone having run them. The pattern is consistent enough to name: this ledger
records *intent* accurately and *residual work* badly, because what remains is
rewritten each tranche while the earlier summary lines are not revisited. A
stale "remaining" line is worse than none — it sends the next session looking for
work that is already finished.

### (16th) The browser a11y smoke test — and what it immediately found

The plan's last unchecked *build* item. It needed `@playwright/test`,
`@axe-core/playwright`, a Postgres service and a browser install in CI; it is now
`pnpm e2e:smoke` (`e2e/a11y.spec.ts`), covering landing, pricing, privacy, login,
signup, the dashboard shell, keyboard reachability, and reduced motion in a real
browser. **8/8 passing locally.**

The value was in the first run, not in the passing suite. It found six things
`jsx-a11y` cannot see, because that rule inspects JSX and none of these exist
until the page renders:

- **`aria-label` on a bare `<span>`** (`PlatformIcon`, the collapsed sidebar
  badge). Prohibited by ARIA and therefore ignored by assistive tech: the icon
  was unlabelled *and* invalid. Nine instances on the landing page alone.
  `role="img"` fixes it — except on the expanded badge, where the visible number
  *is* the name and the label was removed rather than made valid.
- **An icon-only button with no accessible name** (`button-name`, **critical**) —
  the notification bell. A screen-reader user reached a control with no name.
- **`Tailwind's \`dark:\` variant was inert.`** This is the significant one.
  Tailwind v4 compiles `dark:` to `@media (prefers-color-scheme: dark)` — the
  **OS** preference — while `next-themes` puts a `dark` *class* on `<html>`. The
  two disagreed, so all 11 `dark:` utilities followed the OS while the colour
  tokens around them followed the toggle. One `@custom-variant` aligns them.
- **Contrast failures on every gold element.** Both palettes *invert*, so the
  steps that read in one theme fail in the other, and the pairs had been chosen by
  eye: the login button measured 2.98:1, the auth links 3.29:1 light / 3.72:1 dark.
- **An infinite CSS pulse** that `MotionConfig reducedMotion` cannot reach, since
  that governs framer-motion and not keyframes. Now `motion-safe:`.
- **Sidebar section labels at `text-muted-foreground/70`** — 3.61:1. `/85` is the
  floor on that background and is now documented in `docs/development.md`.

**`src/lib/palette-contrast.test.ts`** keeps the colour half from regressing, and
it is a tree scan rather than a list of files, because fixing login immediately
revealed the same inverted pair on `/privacy`, in the app shell, in the sidebar
and in five more components. It reads each file's own class strings — an earlier
version restated the pairs as literals in the test and **putting the old failing
pair back into a component did not fail it**, which is the whole reason a contrast
guard written that way is worse than none.
*Verified by mutation:* reverting any of five sites fails the scan with the ratio
in the message. It checks the filled button's **background** separately, because
that shape (gold fill, neutral label) is invisible to a `text-gold-N` pair check —
two mutations slipped past until that test existed.

**Three of my own mistakes, all caught before they shipped:** a comment blamed
Tailwind class-string ordering when the real cause was the OS media query; the
JSX comment I inserted used `//` and rendered as text (lint caught it); and the
login test counted zero `<h1>` on a page that has one, because `waitForURL`
resolves before Next.js swaps the DOM.

**Then the first CI run failed, which was worth more than the local passes.**

- **A contrast failure that did not exist locally** — 13 elements on the landing
  page, for a button measuring 5.14:1 in both themes against both `next dev` and
  `next start`. The cause is `next dev` compiling Tailwind's CSS on demand: a
  cold runner can hand the page a stylesheet that is still being generated, and
  axe then reports *unstyled* colours. `waitForStyles` now blocks until a token is
  actually readable from `:root` before measuring.
- **A production build was the wrong answer here, and I only found out by trying
  it.** With `next start`, NODE_ENV is production, the auth cookie is `secure`, and
  a secure cookie is dropped over `http://` — so signup failed with "Something went
  wrong" and no test-visible cause. Reverted to `next dev` with the style wait, and
  both facts are recorded in `playwright.config.ts` so the next person does not
  re-derive them.
- **My first style-wait was worse than none.** It probed the first `<button>` for a
  background colour, which timed out on three pages — the landing page has no
  button until its client code mounts. A condition that depends on a specific
  element's style is a condition that can fail for reasons unrelated to what is
  being tested. Replaced with a token check.
- **Signup's 30s timeout was dev-mode compile latency**, not a fault. The dev log
  showed `signUpAction` completing and `GET /dashboard` serving; the test was
  simply giving up before the first route compile finished. Raised to 60s, and the
  test now takes ~15s.

### (15th) Fixing the P2 findings that were still open

AUD-014…033 with the code inspected rather than the status assumed. Four were
real and got fixed; the rest were already closed or are decisions rather than
defects, and are recorded as such.

**AUD-018 — the built-in provider could pick the wrong API format. Real bug.**
```ts
process.env.HILBRAS_AI_BASE_URL || !legacyAnthropic ? "openai" : "anthropic"
```
The base URL outranked the key. A self-hoster with only `ANTHROPIC_API_KEY` who
also set a base URL — to reach a proxy, or just following the docs — got an
Anthropic key with `apiFormat: "openai"`. Every Assistant request failed, while
every field an operator would plausibly check looked correct. The function was
pure and had **no tests at all**, which is why the whole input space was cheap to
cover: 13 tests, written first, two of which failed against the old code. The
format now derives from the key that won; `HILBRAS_AI_API_FORMAT` still overrides,
because a person stating their intent outranks a guess.
*Verified by mutation:* restoring the old precedence fails exactly the two
regression tests and green returns on revert.

**AUD-033 — the Instagram webhook read an unbounded body. Real bug, security.**
`req.text()` on an **unauthenticated** route, before the HMAC check: anyone could
make the server materialise an arbitrary body before a byte was verified. New
`readRequestBody` in `src/lib/http.ts`, capped at 2 MB, checking `content-length`
before reading *and* re-checking while reading — because that header is a claim by
the sender, so a check that trusts it alone is a suggestion. 10 tests plus 6 on
the route itself.
*Verified by mutation:* removing the incremental check fails 5 tests; reverting
the route to `req.text()` fails 3. Both directions, restored green.
Also fixed: the secret check moved ahead of the read, so a misconfigured
deployment no longer reads a body it will refuse.

**AUD-027 — tooling drift.** `next.config.ts` named `@radix-ui/react-icons` in
`optimizePackageImports`; the package is neither declared nor imported anywhere,
so the entry did nothing. Removed. Added `"engines": { "node": ">=24" }` — CI
already pins 24.x, so the declaration matches reality, and `engine-strict` is
unset so it warns rather than blocking.

**AUD-032 — the one `exhaustive-deps` warning was a real staleness bug.** The
sparkles callback closed over `colors` but memoised on `count` alone, so a caller
passing a different palette kept generating the old one. Fixed, and the default
palette hoisted to a module constant so depending on it does not rebuild the
callback every render. **`exhaustive-deps` warnings are now zero** and lint is
down to 26.

Two of my own errors along the way, both caught before they shipped: a comment
claimed the dependency list compared `colors` by contents when it did not, and a
first draft of the reader test used an assignment expression as an argument.

### (14th) Auditing the Release Readiness checkpoint against the code

The checkpoint's five gates were all unchecked while most of the underlying work
was demonstrably done — the same drift as the Task 18 summary, one level up.
`HILBRAS_STUDIO_AUDIT_REPORT.md` is the source of record for severity (4 P0 /46
P1 /47 P2 across AUD-001…033), so I checked the code rather than the task list.

**All 13 high-severity findings (AUD-001…013) verified closed**, one command per
finding. Two needed real inspection rather than a keyword match:

- **AUD-006** (a server action returned decrypted client secrets to the browser)
  is the one I would not have closed on a grep. `src/app/actions/platform.ts`
  *does* still call `getUserCredentialValue(..._client_secret)` — so the keyword
  search is positive, which reads as "still vulnerable". The finding is closed
  because line 29 returns `toPlatformCredentialStatus(...)`, defined in
  `src/lib/credential-status.ts` as `{ clientId, hasClientSecret: Boolean(x) }` —
  a boolean. The secret is read and immediately reduced to a flag. A check that
  stopped at "does this file mention clientSecret" would have reported this
  security finding as open.
- **AUD-020** (four stored preferences nothing consumes) is closed by *removal
  from the UI* with the rationale in place at
  `settings-client.tsx:56` — "a toggle that does nothing is a false claim". The
  schema keeps the columns. That is the honest resolution of a capability-drift
  finding: not shipping the switch beats shipping a dead one.

**Two of my own checks were wrong before they were right,** and both would have
been false claims in the ledger:

- The OAuth env vars (`X_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, …) looked unreferenced
  because they are never written as `process.env.X` — they are named as strings in
  `src/lib/platforms.ts` (`clientIdEnv`) and resolved through the registry. I
  nearly recorded "documented but unused env vars" on a search artifact.
- `.env.example` appeared to be missing the three `HILBRAS_AI_*` overrides. They
  are present, commented out as optional. My parser only matched uncommented
  `KEY=` lines. `NODE_ENV` is the one real absence and it is correct: the framework
  sets it.

So the environment, migrations, and deployment configuration **do** agree. Two
checkpoint gates are now checked on evidence; the P2 gate stays open because
AUD-014…033 need owners and dates, and dating twenty findings is not a judgement
call I should make unprompted.

### (13th) The guardable half of the external-latency criterion

Task 18's acceptance criteria ask that "external-call latency **have
baselines**". Read literally that needs credentials and a network, and it stays
outstanding — but the criterion hides a half that is entirely measurable here,
and leaving the whole thing unaddressed would be the wrong call.

**What determines the worst case is already bounded, and nothing enforced it.**
`fetchWithTimeout` carries a 15s timeout, a 2 MB response cap and redirect
limits; those are what turn "the network is slow" into an error instead of an
outage. They applied to a new platform only if that platform went through the
same helper — and the invariant held *by discipline*. The only raw `fetch` in
`src/` was the one inside the helper itself, which is a property worth a test
because the failure is invisible: a module calling `fetch` directly compiles,
lints, and passes every test while having no timeout at all.

**New guard in `src/layers.test.ts`** — a bare global `fetch(` outside the
fetcher is a failure, reported with file and line and a pointer to the two
helpers to use instead. A second test asserts the fetcher still exists, so a
rename cannot make the rule silently vacuous.

- **Verified by mutation:** an injected bare `fetch` in a real server module is
  caught; `fetch (u)` with a space and `await fetch` inside a `try` are both
  still caught.
- **A false positive found and fixed, which is the part worth recording.**
  A string literal containing `fetch(` tripped the rule — and this codebase
  builds error messages, so `` `Request to ${host} failed: fetch(x)` `` is
  entirely plausible. Comments and dotted forms (`globalThis.fetch`) were already
  handled; literals were not. Literals are now stripped before matching, and all
  four no-flag cases plus all three must-flag cases were re-checked afterwards. A
  guard that cries wolf gets disabled, and a disabled guard loses the real
  violations too — which is the same trade as the mutation-pattern test, and the
  reason to test the negatives rather than only the positives.

### (17th) Chasing the a11y suite's CI failures to a root cause

The browser smoke suite passed 8/8 locally and failed on CI. Getting to a
trustworthy answer took three wrong fixes before one that held, and the wrong ones
are the durable part.

**Wrong fix 1 — wait for *a* stylesheet.** `next dev` emits CSS on demand, so a cold
runner can hand axe a half-styled page and it reports unstyled colours as contrast
failures. The fix was right in principle: `waitForStyles` before measuring.

**Wrong fix 2 — wait for the wrong thing, twice.** Probing the first `<button>` for a
background timed out on three pages (the landing page has no button until its client
code mounts). Replacing it with "is `--background` readable?" was worse — that token
lives in the base stylesheet, which resolves *before* Tailwind emits utilities, so
the same false-contrast failure reappeared on the pricing page. I raised timeouts at
this point, which is treating a symptom: it turned a fast, honest failure into a
slow, dishonest one.

**The fix that got signup green** — wait for the **variant layer** specifically.
Every false contrast failure on the button involved `dark:bg-gold-300
dark:text-foreground`, which arrives in a *later* chunk than the base utilities.

**And then a second run proved the same mistake one level down.** With the canary
checking only `dark:`, CI moved past the button and failed on **14 nav links** —
`text-muted-foreground`, a *base* utility, arriving later still. That pair measures
6.42:1, so axe was measuring it unstyled. A canary that checks one layer misses
exactly the failure it was written for: both have to be present, and the check now
requires a base utility **and** the dark variant before measuring.

Both CI runs are what established this. Locally the suite was 8/8 green throughout,
and every version of the canary "worked" against a warm server — the whole class of
bug is invisible without a cold runner.

**Also fixed along the way:**
- `document-title` was reported on the dashboard, a state the app is never actually
  in — axe was measuring the window between `/dashboard` and `/runtime` during a
  client-side redirect. A double `requestAnimationFrame` was not enough; the settle
  now waits for `readyState === "complete"` and a non-empty `document.title`.
- `expectSingleH1` and `signIn` wait for content rather than counting on arrival.
- `playwright.config.ts` defaulted to `next start` while its own comment and the CI
  job both said `next dev` — and the CI job had no build step, so that default would
  have failed the job before a single assertion ran. Now `next dev` by default, with
  `E2E_PROD=1` as the opt-in, and the two discarded alternatives documented.

**Signup is fixed.** The variant-layer canary resolved the cold-run timeout: the
second CI run had signup passing with only the landing page failing.

**What CI has actually established, as of three runs:**
1. Run 1 — 13 contrast failures on the landing CTA. Cause: the `dark:` variant
   layer had not loaded; axe measured the button unstyled.
2. Run 2 — signup passing; 14 contrast failures on the landing *nav*, a base
   utility. Cause: the base layer had not loaded. (Signup's fix was a side effect
   of waiting for both layers.)
3. Run 3 — signup passing; 15 on the *same* nav element, unchanged after adding a
   second check. That element measures 6.42:1 and zero violations locally, so the
   page is still being measured before that particular rule lands.

**A fourth attempt that I reverted, and why it is worth recording.** The third
failure's natural reading is "the canary's probe element is styled by an earlier
chunk than the page's", so the fix was to wait on a real `text-muted-foreground`
element — the class the landing nav actually uses. That made the *dashboard* fail
locally (16 violations at `h1`), because the dashboard has no such element at the
moment the check runs, so it advanced at the wrong point. Reverted. The lesson is
narrower than "my fix was wrong": a readiness probe keyed to an element a
particular page happens to contain is a probe for that page, not for the suite, and
it will mis-time every other page.

**Two more causes, found the same way — by a cold runner that local never
reproduces:**

4. **A `motion.header` opacity animation behind a `backdrop-filter` glass panel.**
   axe composites a partially-transparent element against its backdrop, so read
   mid-animation it reports contrast failures for text that measures ~6:1 once
   settled. The suite now waits for running opacity animations via the
   web-animations API, filtered to `targetProperty` because that is the only
   property that changes composited colour — and narrowing to it mattered, since a
   blanket "wait for all animations" would block forever on the three infinite
   `spin` animations on the landing page.

5. **The signup server action compiles on first *invocation*, not on first GET.**
   Measured with `.next` deleted: the five warmed routes cost 1.7s–22.5s, and
   signup still ran past 300s — because the action behind the form is compiled
   separately and a `GET /signup` provably does not trigger it. A GET-based warm-up
   added to the test that needs it was tried and **removed**: it cannot do the job,
   and leaving it in would be decoration.

**Fixed, and verified the only way that means anything.** `seedUser`'s budget is
300s (the per-test limit raised to 330s so it cannot fire first and misname the
failure), then verified against a **cold-started** dev server with `.next` deleted:
**8/8 in 3.1 minutes**, signup at 28.6s. The same suite failed at 300s minutes
earlier in the session against an equally cold build — which is the difference
between having a number and having checked it.

The general lesson, and it is the fourth time in this series: **every one of these
bugs was invisible locally.** Locally the suite was 8/8 green through all five, and
each version of every fix appeared to work. Only a cold runner distinguishes
"waiting for readiness" from "waiting for the right readiness", which is an argument
for the suite living in CI rather than on a laptop.

**Not solved, and recorded in place at the failing line.** On a *cold* dev server the
signup test has timed out at 120s with no server-side error: the log shows
`signUpAction` completing and both `/dashboard` and `/runtime` serving, while the
page never leaves `/signup` from the test's point of view. A warm server takes ~20s.
An explicit warm-up (`e2e/global-setup.ts`) did not explain it — it compiled every
route in about a second, so compile time is not the cost. That is a real loose end,
and it is written down next to the timeout rather than left for someone to rediscover.

Verified: 538 unit tests (49 files) · 214 integration · typecheck clean · lint 0/26 ·
e2e smoke 8/8 against a warm server.

### (18th) Closing the last gate I can close, and the rot it found

**The clean-checkout gate is now checkable**, which it was not before: CI run
`36781800337` on `b6a3465` is green on both jobs, including **Browser a11y smoke**
(8/8, from a cold runner). The gate had been recorded as "browser gate absent —
cannot pass or fail", which was true when written and stopped being true the moment
the suite landed. It was corrected rather than left, since a gate that describes a
missing thing reads as an open question to the next reader.

**Checking the remaining config gate found a real gap.** "Documentation,
environment, migrations, and deployment configuration agree" had never actually
been checked. It had: the a11y suite added `TEST_DATABASE_URL`, and **no document
mentioned it**. Not `.env.example`, not the README, nothing — while
`docs/development.md` *named* it in a sentence telling you to point it at a
database without showing how. A contributor could read that section and still not
be able to run the command.

- **`docs/development.md`** now has the runnable example: a `docker run` for
  Postgres, the four variables with what each is for, the migrate step, and the
  run. It notes that `TEST_DATABASE_URL` is separate from `DATABASE_URL`
  deliberately, so the suite cannot run against a developer's working database by
  accident, and gives the cold/warm timings.
- **New guard in `src/docs.test.ts`** — a variable CI *sets* must appear in
  `.env.example`, README, `docs/development.md`, or `docs/DEPLOYMENT.md`. Scope is
  deliberately narrow: CI-set variables, not every `process.env` read, since a
  variable only the application reads has no business in a contributor document.
  Framework-owned names (`CI`, `PATH`, `NODE_ENV`, `NEXT_*`) are allowlisted with
  the reason.

  *Verified by mutation both ways:* injecting an undocumented variable into the
  workflow fails it with a message naming where to document it, and reverting my
  doc fix so `TEST_DATABASE_URL` is undocumented also fails it. Green on restore.

This is the same rot `docs.test.ts` already guards for **file paths** — a reference
to something real that a reader cannot find — and it went unnoticed for the same
reason: nothing looked. The file's own docstring says the point is that a new
violation fails in CI; this is the first time that claim applied to a category the
file did not cover.

### Verification for the series

540 unit tests (49 files) · 214 integration tests (18 files) · typecheck clean ·
lint 0 errors / 26 warnings (zero `exhaustive-deps`; down from 29 because the deleted dashboard
components carried warnings) · production build green · bundle budget green.
One warning in the new script was mine and was removed rather than absorbed into
the baseline; the six lint *errors* in the first version of the plan test were
also mine (an `any`-typed plan node) and were fixed by typing the shape rather
than suppressing the rule.

## Migration note — 0017_state_checks

- **What it does:** four CHECK constraints closing the last state columns that
  the application policed but the database did not — `runs.state`,
  `run_steps.state`, `run_step_approvals.state`, and `goals.status`. The
  vocabularies are the ones `EXECUTION_STATES` in `src/lib/runtime/state.ts`
  already declares; this makes a writer that disagrees fail at the write.
- **Verification:** generated by drizzle-kit from `src/db/schema.ts`, so the
  journal and snapshot are consistent by construction and
  `drizzle-kit check` passes. `tests/integration/database.test.ts` asserts each
  constraint fires (by constraint name) and that the modeled values still write
  — including `expired`, the sweeper's own write, which would break the expiry
  sweep if the list were wrong. Verified by mutation: emptying the migration
  fails exactly that test and leaves the other five in the file green.
- **⚠️ Preflight — this migration can fail on existing data.** Unlike 0015 it is
  not purely additive: a row already holding a value outside the list makes the
  `ADD CONSTRAINT` fail. Run these first:
  ```sql
  SELECT state, count(*) FROM runs GROUP BY 1;
  SELECT state, count(*) FROM run_steps GROUP BY 1;
  SELECT state, count(*) FROM run_step_approvals GROUP BY 1;
  SELECT status, count(*) FROM goals GROUP BY 1;
  ```
  Expected: exactly the modeled values. Repair before migrating — rewrite an
  unexpected run or step state to the nearest modeled one
  (`awaiting_approval` → `pending` is the safe direction for a run that was
  interrupted, since a terminal state would be a lie about work that may not
  have happened) and an unexpected goal status to `paused` rather than
  `active`: an unrecognized status is far more likely to be a paused goal than
  one that has been firing.
- **Rollback:**
  ```sql
  ALTER TABLE "runs" DROP CONSTRAINT "runs_state_check";
  ALTER TABLE "run_steps" DROP CONSTRAINT "run_steps_state_check";
  ALTER TABLE "run_step_approvals" DROP CONSTRAINT "run_step_approvals_state_check";
  ALTER TABLE "goals" DROP CONSTRAINT "goals_status_check";
  ```
  Purely a constraint removal, so the rollback loses nothing — the application
  never depended on the database to enforce these. Note that after a rollback
  the `goals_due_idx` partial-index argument above no longer holds, because a
  fourth status becomes storable again.
- **Operational cost:** `ADD CONSTRAINT ... CHECK` takes `ACCESS EXCLUSIVE` and
  scans the table once, but writes no rows and creates no new table, so this is
  a brief lock rather than the rewrite that 0016 required.

## Phase 0: Safety Baseline

- [ ] **Task 0 — Inventory and rotate local secrets** — operational, see work order 11. **Depends on:** none.
- [x] **Task 1 — Establish test and CI foundations** (re-verified 2026-09-29)
- [x] **Task 2 — Fix Composer scheduling and save-state transitions** (re-verified)
- [x] **Task 3 — Define and enforce platform capabilities** (core verified; remaining: exact-count contract test, media capability contract, server-side createPost validation — work order 2)
- [x] **Task 4 — Add global AI spend and request limits** (verified; remaining: limiter DB-failure test)
- [x] **Task 5 — Harden provider URL fetching against SSRF** (verified; remaining: reserved-range additions — work order 2)
- [x] **Task 6 — Remove platform secrets from browser responses** (verified)
- [ ] **Task 7 — Make cron/manual publishing CSRF-safe and server-authoritative** — remaining: result-URL restriction, fabricated-outcome test (work order 1). **Depends on:** Tasks 1 and 6.
- [ ] **Task 8 — Implement truthful account export and deletion** (work order 8). **Depends on:** Tasks 1 and 7; requires a database design decision.

### Checkpoint: Safety Baseline

- [x] P1 security/correctness fixes have focused tests.
- [x] No decrypted secrets appear in client responses.
- [x] No client request can trigger an unintended scheduled publish.
- [x] Provider URLs and model spend are bounded.
- [ ] Account deletion/export behavior is approved.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass. (green at re-baseline; re-verify per session)

## Phase 1: Reliability and Data Integrity

- [ ] **Task 9 — Build and test the OAuth provider matrix** (work order 6). **Depends on:** Tasks 1, 3, and 5.
- [x] **Task 10 — Add scheduler leases, time budgets, and idempotency** (verified)
- [ ] **Task 11 — Make multi-platform publishing settle independently** — core done; remaining: server-side result validation, all-failure/timeout tests, display parity (work order 1). **Depends on:** Tasks 7 and 10.
- [ ] **Task 12 — Add database constraints, indexes, and tenant defense-in-depth** (work order 3). **Depends on:** Tasks 8–10.
- [ ] **Task 13 — Standardize timezones and external HTTP behavior** (work order 4). **Depends on:** Tasks 4, 5, and 10.
- [ ] **Task 14 — Correct analytics, inbox, and preference behavior** (work order 7). **Depends on:** Tasks 1, 3, and 11.

### Checkpoint: Reliability and Data Integrity — **CLOSED 2026-09-29**

- [x] OAuth contracts and refresh behavior are tested.
- [x] Scheduler claims, timeouts, and duplicate behavior are tested.
- [x] Database constraints and tenant isolation are verified.
- [x] Timezone and external HTTP behavior are bounded.
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and migration checks pass.

## Phase 2: Cleanup and Refactoring

- [x] **Task 15 — Remove confirmed dead code and dependencies** (quick wins 2026-09-29; final reference-checked sweep 2026-09-30 — **closed**).
- [ ] **Task 16 — Rewrite documentation and product claims** (pricing/testimonials/public claims done; developer-doc path rot fixed 2026-09-30 and now guarded by `src/docs.test.ts`. Remaining: product-owner sign-off on public claims, which is not machine-checkable).
- [x] **Task 17 — Extract server data and publishing boundaries** (**tranches 1–4 done 2026-09-30** — publish split, `ai.ts` by concern, the dashboard/analytics owner-scoped read layer, and the DTOs out of the `"use server"` modules; boundaries enforced by `src/layers.test.ts` and 21 mutations in `scripts/mutate-task17.sh`). **Depends on:** Tasks 9–14.
- [ ] **Task 18 — Add observability, performance, and accessibility guardrails** (**four tranches done 2026-09-30** — structured logger, CI bundle budget, reduced motion, and the Task 12 query-plan evidence in `index-plans.test.ts`; remaining: browser a11y smoke, and the credentialed half of external-call latency — the bounded-fetch guard now covers the half that is measurable here). **Depends on:** Tasks 1, 13, and 16.

### Checkpoint: Release Readiness

Verified 2026-09-30 against the code rather than against the task list — see
entry (14th). `HILBRAS_STUDIO_AUDIT_REPORT.md` is the source of record for the
P0/P1/P2 severities (4 / 46 / 47).

- [x] All P1 findings are closed or explicitly accepted. **All 13 high-severity
  findings (AUD-001…013) verified closed in the code**, 2026-09-30. AUD-006 was
  the only one needing inspection to confirm: `platform.ts` now returns
  `toPlatformCredentialStatus(...)`, which yields `hasClientSecret: Boolean(x)` —
  a boolean, never the value.
- [ ] P2 findings have owners and dates or documented risk acceptance. **Partly
  triaged 2026-09-30** — see entries 15th and 16th: AUD-018/027/032/033 fixed,
  AUD-015/016/019/020/024/026 already closed, the rest are product decisions
  recorded below. **Open** The 20 medium findings are AUD-014…033 in the audit report, and
  several are already resolved by this series (the analytics all-failed counts,
  the inert-preference toggles, the pricing/testimonial claims, the doc-path rot).
  **Triaged 2026-09-30.** AUD-018, AUD-027, AUD-032 and AUD-033 were real and are
fixed (entry 15th). Of the rest, AUD-015/016/019/020/024/026 were already closed
by earlier tranches. What remains needs a decision, not a fix: AUD-014 (capability
drift — encode media/account differences in the registry vs scope the UI),
AUD-021 (RLS and transaction boundaries — a design decision with a real cost),
AUD-022/AUD-037 (public-media quota as an explicit product decision), AUD-028
(stronger password KDF and session revocation — a breaking change to auth),
AUD-029/030/031 (deployment-dependent behaviour that cannot be exercised without
staging). None is a defect I can fix without knowing what you want the product to
do. What was missing is the **triage**: which of the remainder are
  accepted risk, which get an owner and a date, and which are simply out of scope.
  That is a product call — dating twenty findings and assigning owners is not a
  judgement I should make unprompted. The list is small enough to walk in one
  sitting once you want it.
- [x] Dead-code decisions are recorded. Task 15 closed 2026-09-30; the five
  modules kept over deletion are listed in `KEPT` in `src/layers.test.ts`, each
  with the reason it earns its maintenance cost.
- [ ] Documentation, environment, migrations, and deployment configuration agree.
- [x] Clean-checkout test, lint, typecheck, build, migration, audit, and browser
  gates pass. **All eight verified green on `main` 2026-09-30**, CI run
  `36781800337` (commit `b6a3465`), both jobs: Quality gates (lint, typecheck, 538
  unit / 214 integration, build, client bundle budget, `drizzle-kit check`,
  dependency audit) and **Browser a11y smoke** (8/8, from a cold runner).

  The browser gate was recorded here as *absent* for most of this series, and
  listing it that way was correct until it existed. It is worth noting what
  building it cost: five CI rounds, because every one of the bugs it found was
  invisible locally. `jsx-a11y` could not see any of them, and neither could a
  green local run.

## Per-Task Completion Checklist

- [ ] Focused tests added or updated.
- [ ] Acceptance criteria in `tasks/plan.md` are satisfied.
- [ ] Verification commands pass.
- [ ] Database changes include migration verification and repair/rollback notes.
- [ ] External API changes include mocked and, where possible, sandbox verification.
- [ ] User-facing behavior and documentation are updated together.
- [ ] No unrelated cleanup is included.
