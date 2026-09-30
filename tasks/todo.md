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
| 18 Observability/a11y | **Third tranche done 2026-09-30** | `src/lib/logger.ts` — one JSON object per line (`ts`, `level`, `event`, flat fields), unit-tested — carries the events the plan names: `publish_run_finished`, `token_request_failed`/`token_rotation_failed`, `ai_budget_denied`, `account_deleted`. `eslint-plugin-jsx-a11y` recommended rules run in `pnpm lint`, which CI enforces. **2026-09-30 — bundle budget.** New `scripts/bundle-budget.mjs`, wired into CI after the build: gzipped first-load JS per prerendered route, failing over 295 KiB total / 82 KiB largest chunk (measured baseline: `/` at 254.1 KiB, largest chunk 69.8 KiB). **It reads the `<script src>` tags out of each route's emitted HTML, not the per-route build manifest** — Turbopack's manifest carries only the shared `rootMainFiles`, identical for all 49 routes, so a budget built from it compares one number with itself; that is how the first draft was wrong. Dynamic (ƒ) routes are reported as unmeasured rather than counted as zero. `--update` re-baselines to measurement **+15%**, verified idempotent, and both thresholds were verified to fail. **2026-09-30 — reduced motion.** 26 components animate through framer-motion and the only reduced-motion handling in the product was one CSS rule for the docs fade, so a visitor whose OS asks for reduced motion still received every JS-driven animation. Fixed with `MotionConfig reducedMotion="user"` in the root provider — one place, above every route. Three static guards keep it wired, each verified to fail when the fix is removed. Remaining: **browser-level a11y smoke** (needs `@playwright/test` + a CI browser install — a dependency and workflow decision, not made unilaterally); external-call latency baselines; query-plan evidence for the Task 12 indexes. |

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
10. **Task 18** — observability (three tranches: structured logger, CI bundle budget, reduced motion). Remaining: browser a11y smoke (needs a Playwright dependency + CI browser install — owner's call), external-call latency baselines, query-plan evidence for the Task 12 indexes.
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

### Verification for the series

500 unit tests (45 files) · 205 integration tests (17 files) · typecheck clean ·
lint 0 errors / 27 warnings (down from 29 because the deleted dashboard
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
- [ ] **Task 18 — Add observability, performance, and accessibility guardrails** (**three tranches done 2026-09-30** — structured logger, CI bundle budget, reduced motion; remaining: browser a11y smoke, external-call latency baselines, query-plan evidence for the Task 12 indexes). **Depends on:** Tasks 1, 13, and 16.

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
