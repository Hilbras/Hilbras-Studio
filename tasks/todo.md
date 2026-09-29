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
| 1 Test/CI foundations | **Done** | `.github/workflows/ci.yml` runs install→lint→typegen→typecheck→unit→integration→build→migration check→audit. 421 unit tests + Testcontainers integration suite. Only gap: analytics untested. |
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
| 12 DB constraints | Partial → **core constraints added 2026-09-29** | Uniqueness/indexes/tenant isolation (documented app-only branch) verified on the new schema. **2026-09-29: migration 0014 adds a CHECK on `posts.status` (five terminal states) and a partial unique index enforcing one default `ai_providers` row per user, both integration-tested; `registerConnection`, provider selection, and the provider save path are now transactional.** Remaining: CHECK/enum for `run_steps.state`/`runs.state`; EXPLAIN before/after evidence for the index strategy. |
| 13 Timezones/HTTP | **Done (2026-09-29)** | Goals use `timestamptz` + DST-tested cron; single HTTP funnel (`http.test.ts` enforces no raw `fetch`); `fetchWithTimeout` does not follow redirects and bounds every response body at 2 MiB inside the total deadline; the assistant stream cancels upstream generation on client disconnect. **2026-09-29: migration 0016 converts all 33 remaining bare `timestamp` columns to `timestamptz` with explicit `AT TIME ZONE 'UTC'` casts — one timestamp contract; the scheduler, claim-lease, and rate-limit comparisons no longer depend on the server's timezone, verified by the full integration suite.** |
| 14 Analytics/inbox/prefs | **Done (2026-09-29, one recorded scope decision)** | Analytics reads real results incl. partial success; query bounded (`.limit(500)`); a failed provider fetch is reported per platform ("X: …") instead of reading as an empty inbox. **2026-09-29: inbox read state persists (`inbox_read_state` table, 30-day pruning, per-message `markInboxRead` action, unread count survives reloads); the four inert preference toggles are removed from the UI — none changed behavior, and a toggle that does nothing is a false claim (columns retained in schema, documented for reintroduction). Goal-run publishes in the analytics dashboard are recorded OUT OF SCOPE: receipts record successes only, so merging them into a published/failed split would distort the stats, and run outcomes are already visible in the Runs view — revisit only if the dashboard gains a runtime section.** |
| 15 Dead code | Partial → **confirmed residue removed 2026-09-29** | **2026-09-29: `src/lib/mock-data.ts` deleted (zero importers); the four unused direct dependencies (@tanstack/react-query, zustand, @hookform/resolvers, react-hook-form) removed and the lockfile regenerated.** Remaining: a final reference-checked sweep after the behavior work stabilizes (plan's original ordering). |
| 16 Docs truthfulness | Partial → **public-facing claims fixed 2026-09-29** | README/platform claims match the registry (done by the rebuild). **2026-09-29: the pricing page no longer quotes unimplemented tiers/trial/seats (now: free while v1 is built, honest capability list); fabricated testimonials removed from the landing page; the CTA no longer claims GDPR compliance; the privacy page now describes the retention/deletion scope that actually exists and marks self-serve export/deletion as roadmap instead of promising it.** Remaining: canonical setup docs pass, product-owner sign-off on public claims. |
| 17 Boundaries/DAL | Not started | Actions and server pages import `@/db` directly; `publish.ts` 952 LOC; client components import fat action modules. |
| 18 Observability/a11y | Not started | No structured logging/metrics; no bundle/CWV budgets; no a11y tests. |

## Work order (re-baselined priority)

1. ~~**Task 7/11 close-out**~~ **done 2026-09-29**.
2. ~~**Task 15 quick wins**~~ **done 2026-09-29**.
3. ~~**Task 12** — migration 0014, transactional writes~~ **done 2026-09-29**.
4. ~~**Task 13** — bounded bodies + redirects, disconnect cancellation, one timestamp contract (migration 0016)~~ **done 2026-09-29**.
5. ~~**Task 16 remainder** — pricing/testimonials/privacy claims~~ **done 2026-09-29** (owner sign-off remains).
6. ~~**Task 9** — OAuth provider matrix~~ **done 2026-09-29** (sandbox verification per provider remains with the operator).
7. ~~**Task 14** — read-state persistence, provider errors, preferences removed~~ **done 2026-09-29** (goal-run analytics recorded out of scope).
8. ~~**Task 8** — export + self-serve deletion~~ **done 2026-09-29** (retention/backup runbook remains with the operator).
9. **Task 17** — DAL extraction, publish.ts split (multi-PR; the only code work left besides 18).
10. **Task 18** — structured logging, budgets, a11y smoke (multi-PR).
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

- [ ] **Task 15 — Remove confirmed dead code and dependencies** (work order 2 — quick wins; rest after stabilization).
- [ ] **Task 16 — Rewrite documentation and product claims** (work order 5 — pricing/testimonials remain).
- [ ] **Task 17 — Extract server data and publishing boundaries** (work order 9; split into multiple PRs before implementation). **Depends on:** Tasks 9–14.
- [ ] **Task 18 — Add observability, performance, and accessibility guardrails** (work order 10). **Depends on:** Tasks 1, 13, and 16.

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
