# Hilbras Studio — Deep Repository Audit

**Audit date:** 2026-09-24
**Audited revision:** `a718d43099f95b6ab39f76221526170e3c13f9a0` (`main`, matching `origin/main`)
**Mode:** Read-only repository analysis of the pre-remediation revision. No application source, configuration, dependency, migration, or documentation file was changed during the audit phase. Remediation work is tracked separately in `tasks/plan.md` and `tasks/todo.md`.

## Executive Summary

Hilbras Studio is a real Next.js 16/React 19 application rather than a static mockup. It has a working authentication/session layer, encrypted credential storage, PostgreSQL/Drizzle persistence, a request-triggered scheduler, OAuth/manual account connections, AI provider configuration, an Assistant stream, and five concrete publishing paths. The current production build and TypeScript check pass, and the native pnpm audit reports no known dependency advisories.

The repository is **not production-ready without remediation**, however. The highest-risk findings are a Composer path that can publish immediately while the UI says “Schedule,” a registry/UI that advertises ten publishing platforms while only five have publishers, an unbounded shared-AI-cost surface, an SSRF design that follows redirects after only validating the initial URL, browser exposure of platform client secrets, incomplete data-deletion/privacy workflows, and a scheduler that can time out or re-publish after a crash. The app also has no automated tests or CI, and its normal lint command is currently red.

This report distinguishes:

- **Confirmed repository defects:** directly demonstrated by source, generated build output, static analysis, or a successful local command.
- **Potential runtime risks:** strongly supported by code but dependent on deployment, provider behavior, traffic, or a race that was not reproduced against live services.
- **Incomplete product features:** real UI/code paths that are persisted or displayed but do not yet implement the advertised behavior.
- **Cleanup candidates:** only files/symbols for which imports, dynamic loading, framework conventions, configuration, tests, build manifests, and Git history were checked.

### Headline metrics

| Metric | Result |
|---|---:|
| Tracked files inspected | 151 |
| Files under `src/` | 113 (111 TypeScript/TSX, one CSS file, one favicon) |
| Server-action files | 13 |
| Route-handler files | 10 |
| Library/service files | 20 |
| Component files | 30 |
| Test files / test suites | **0** |
| Direct production dependencies | 36 |
| Direct development dependencies | 10 |
| Drizzle SQL migrations | 6, plus 7 tracked metadata/snapshot files |
| Registry platforms | 10 |
| Publishers actually dispatched | 5: Instagram, Facebook, X, Threads, Telegram |
| P0 findings | 0 |
| P1 findings | 13 |
| P2 findings | 20 |
| P3/P4 findings | 7 |

The finding counts are audit findings, not a claim that every symptom has a separate root cause. Several related symptoms are intentionally grouped under one ID.

## Repository Overview

### Inventory

| Area | Contents | Status |
|---|---|---|
| Runtime | Next.js App Router pages, layouts, server actions, route handlers, `src/proxy.ts` | Active |
| Persistence | PostgreSQL via `pg` + Drizzle; schema and six migrations | Active, with integrity/RLS gaps |
| Publishing | Shared platform registry, five publishers, Telegram manual connector, scheduler | Partially complete |
| AI | Built-in provider configuration, per-user providers, Composer tools, Assistant stream, memory | Functional core; spend and stream controls incomplete |
| UI | Landing/auth/dashboard/docs pages, shadcn-style primitives, motion components | Builds; several controls are placeholders |
| Tooling | `package.json`, `pnpm-lock.yaml`, ESLint, Tailwind/PostCSS, Drizzle Kit, Vercel config | Build works; lint/CI/scripts incomplete |
| Tests/CI | No test files, runner, coverage configuration, or CI workflow | **Missing** |
| Containers | No Docker/container configuration | Not present |
| Deployment | `vercel.json`, deployment docs, environment template | Vercel-oriented; runtime assumptions need verification |
| Workspace/monorepo | Single package; no workspace configuration | Simple single-service architecture |

### Actual entry-point map

```text
Public pages / auth pages
        │
        ├── src/proxy.ts (Next 16 Proxy; optimistic route/session gate)
        │
        ├── Server Components
        │     ├── dashboard / accounts / composer / scheduler
        │     ├── assistant / inbox / analytics / settings
        │     └── docs / pricing / privacy
        │
        ├── "use server" actions in src/app/actions/*
        │     ├── authentication and settings
        │     ├── posts, publishing, platform credentials
        │     ├── AI providers and AI tools
        │     └── chat, memory, inbox, analytics
        │
        └── Route handlers in src/app/api/*
              ├── assistant stream and connection health
              ├── OAuth authorize/callback
              ├── Threads deauthorize/data-deletion callbacks
              ├── Instagram webhook
              ├── media upload/retrieval
              └── scheduled-publish cron/manual trigger

Server actions/routes
        │
        ├── src/lib/session.ts + src/lib/crypto.ts
        ├── src/lib/platforms.ts + platform credential/token modules
        ├── src/lib/publish.ts + scheduled-posts.ts
        ├── src/lib/ai.ts + ai-sdk.ts
        ├── src/lib/chat.ts + connection-health.ts
        └── src/db/index.ts → PostgreSQL
                                  │
                                  ├── official social APIs
                                  ├── Telegram Bot API
                                  └── configured AI providers
```

### Build and static verification performed

| Check | Result | Interpretation |
|---|---|---|
| `NEXT_TELEMETRY_DISABLED=1 pnpm build` | **PASS** | Next 16.3.6 compiled, type-checked, and generated 31 routes |
| `pnpm exec tsc --noEmit --incremental false` | **PASS** | No TypeScript errors |
| `pnpm exec drizzle-kit check --config=drizzle.config.ts` | **PASS** | Drizzle metadata is internally consistent |
| `pnpm lint` | **FAIL** | 38 problems: 11 errors and 27 warnings |
| `pnpm audit --json` | **PASS** | 0 known advisories across 624 resolved dependency entries |
| `pnpm outdated --format list` | Review needed | Patch updates for Framer Motion/Lucide; major updates for ESLint/TypeScript/Node types |
| `pnpm test` / `pnpm typecheck` | Missing script | No test or typecheck script is declared |
| Worktree before report creation | Clean on `main` | No tracked source changes were present |

Build artifacts were used only as corroborating evidence. The generated `.next` directory is ignored and is not treated as source of truth. No live PostgreSQL/Supabase, OAuth, Telegram, Meta, AI-provider, Vercel deployment, or browser/E2E calls were made; those paths are marked for manual or integration verification where noted.

### Generated and ignored artifacts

| Path | Classification | Action |
|---|---|---|
| `.next/` | Generated Next build output | Safe to regenerate; do not commit |
| `node_modules/` | Installed dependencies | Regenerate from the lockfile |
| `tsconfig.tsbuildinfo` | Generated incremental compiler state | Safe to regenerate |
| `next-env.d.ts` | Next-generated framework file | Keep/regenerate; do not classify as application dead code |
| `.env.local` | Local environment file containing populated secrets | Keep only in a controlled workspace; rotate if shared |
| `data/hilbras.db*` | Ignored pre-PostgreSQL SQLite artifacts | Back up and manually verify before removing |
| `.zcode/`, `.freebuff/` | Local tool metadata/plans | Manual verification; not application source |
| `drizzle/meta/` | Generated migration metadata | **KEEP**; required to interpret migration history |

## Architecture Overview

### What is working correctly

1. **Framework entry points are real.** `src/proxy.ts` is the Next 16 replacement for the old middleware convention. The production build reports `ƒ Proxy (Middleware)`, and the generated route manifest contains every page and API route.
2. **Authentication has meaningful defense in depth.** Passwords use bcrypt; JWTs are signed; cookies are `httpOnly`, `sameSite=lax`, and `secure` in production; `token_version` revokes old sessions after password changes; protected layouts perform a database-backed session check in addition to the Proxy signature check.
3. **Secret storage is encrypted and tenant-scoped.** OAuth tokens and provider keys use AES-256-GCM with authentication tags; user credential lookups include `userId`; the current connection code does not intentionally borrow another user’s saved credential row.
4. **Database access is parameterized.** Drizzle queries and the rate-limit SQL use bound parameters; no shell execution, `eval`, `innerHTML`, or obvious SQL string concatenation was found.
5. **The normal scheduler overlap protection is sound for the common case.** A conditional `scheduled → publishing` update prevents two ordinary concurrent runs from claiming the same row.
6. **Meta-specific hardening is substantial.** Long-lived-token upgrade, proactive refresh, expired-session detection, Threads permission classification, and tenant scoping for signed Meta callbacks are implemented.
7. **Upload validation has a useful baseline.** The media route checks size, declared type, and leading magic bytes before storing bytes.
8. **Initial SSRF checks and security headers exist.** The AI URL guard rejects literal/DNS-resolved private addresses in production, and the app sets CSP, HSTS, frame, referrer, MIME, and permissions headers.

### Architectural problems

- The platform registry conflates **connectable**, **configured**, **connected**, and **publishable** platforms. This is the source of several user-visible failures.
- The application has no dedicated data-access layer. Server actions directly query Drizzle and contain orchestration, validation, authorization, and persistence together.
- `src/lib/ai.ts` imports application-layer dashboard actions, reversing the intended dependency direction and making the AI service depend on UI-facing modules.
- `src/lib/publish.ts` is a 907-line multi-platform service with duplicated HTTP/error/token patterns. It should be split by connector behind a common contract, not rewritten wholesale.
- Several large client pages (`accounts`, `composer`, `settings-client`, Assistant, Inbox) combine data loading, optimistic state, error presentation, and feature logic in one component.
- Important invariants are represented as free-form strings and application filters rather than database constraints: post status, platform IDs, account uniqueness, AI-provider default uniqueness, and tenant isolation.
- There is no structured logging, metrics, tracing, alerting, or durable audit trail for publish attempts, token failures, AI spend, or webhook activity.

## Consolidated Findings Table

| ID | Category | Severity | Confidence | Location | Problem | Recommended Action |
|---|---|---|---|---|---|---|
| AUD-001 | Correctness | P1 | HIGH | `src/app/(dashboard)/composer/page.tsx:190-218` | Schedule mode with no date falls through to immediate publishing; DB save errors are ignored. | Require a valid date/time and stop on `createPostAction` errors before any publish call. |
| AUD-002 | Feature correctness | P1 | HIGH | `src/lib/platforms.ts:14-25`; `src/lib/publish.ts:836-859` | Ten platforms are exposed, but only five have publishers. | Separate connectable from publishable capabilities and disable/mark unsupported platforms. |
| AUD-003 | Security / cost | P1 | HIGH | `src/app/actions/auth.ts:47-96`; `src/app/actions/ai.ts:109-211`; `src/app/api/assistant/route.ts:77-110` | Open signup can spend the built-in key; only the Assistant route is rate-limited. | Add global per-account/IP quotas, token/output caps, verification/invite controls, and bounded fail-closed behavior. |
| AUD-004 | Security | P1 | HIGH | `src/lib/net-guard.ts:5-16,80-120`; `src/lib/ai-sdk.ts:61-68,96-103` | SSRF validation covers only the initial URL; `fetch` follows redirects and DNS can rebind. | Disable redirects or validate each hop, pin/filter egress IPs, and keep private ranges blocked. |
| AUD-005 | Privacy / security | P1 | HIGH | `src/app/api/connect/threads/delete/route.ts:40-67`; `src/app/privacy/page.tsx:123-139` | Meta deletion removes only a Threads connection, not the represented user’s data; no account deletion/export workflow exists. | Implement end-to-end deletion/export, backups/retention handling, and truthful callback semantics. |
| AUD-006 | Security | P1 | HIGH | `src/app/actions/platform.ts:25-30`; `src/app/(dashboard)/accounts/page.tsx:218-226` | A live server action returns decrypted platform client secrets to the browser. | Return presence/masked metadata only; require re-entry to replace a secret. |
| AUD-007 | Async / correctness | P1 | HIGH | `src/lib/scheduled-posts.ts:24-35,69-106,145-198`; `src/lib/publish.ts:632-648` | Ten sequential posts can exceed serverless limits; stranded recovery can duplicate a post after a crash and has no lease token. | Bound work by elapsed time, use an idempotency/lease strategy, and define at-least-once behavior explicitly. |
| AUD-008 | OAuth correctness | P1 | MEDIUM | `src/lib/platforms.ts:47-58,160-171,275-286`; callback `:96-131` | `tokenAuth: basic`, `usesPkce`, and some provider-specific exchange modes are not implemented; refresh tokens are never read. | Add a provider protocol matrix and test each exchange/refresh path against official APIs. |
| AUD-009 | Security / data integrity | P1 | HIGH | `src/app/actions/posts.ts:117-136`; `src/app/(dashboard)/analytics/analytics-clients.tsx:71-77` | A client-invokable action trusts publish results and accepts arbitrary URL strings, enabling status fabrication and unsafe-link rendering. | Move terminal-state writes server-side; allow only `https:`/known platform URLs. |
| AUD-010 | Security | P1 | HIGH | `src/app/api/cron/publish-scheduled/route.ts:34-53` | A state-changing `GET` accepts a Lax session cookie without CSRF protection; a cross-site top-level navigation can publish due posts. | Use `POST` plus an origin/CSRF check, or require a one-time action token. |
| AUD-011 | Secret management | P1 | HIGH | `.env.local` (ignored, not committed) | The workspace contains populated session, encryption, database, AI, and webhook secrets; the file is group/other-readable in the inspected workspace. | Treat the workspace as exposed if shared; restrict permissions, rotate all values, and verify secret history/logs. |
| AUD-012 | Quality / operational | P1 | HIGH | `package.json:5-10`; repository root | There are zero tests, no test runner, and no CI quality gate. | Add unit, PostgreSQL integration, route, OAuth, and critical browser tests; gate lint/typecheck/build. |
| AUD-013 | Async / data integrity | P1 | HIGH | `src/lib/publish.ts:869-878`; `src/lib/scheduled-posts.ts:176-196` | `Promise.all` can reject after other platform calls have already published, then records one failure result for the whole post. | Use `Promise.allSettled`, retain per-platform outcomes, and make finalization idempotent. |
| AUD-014 | Publishing correctness | P2 | HIGH | `src/lib/publish.ts:422-450,510-575,581-611` | Instagram always sends `IMAGE`; X drops media; Facebook chooses the first page and treats media as a URL; registry rules overstate support. | Implement explicit per-platform media/account capabilities and reject unsupported combinations before saving. |
| AUD-015 | Analytics correctness | P2 | HIGH | `src/app/actions/analytics.ts:105-179` | Platform breakdown counts failed targets, all-failed posts are excluded from failure stats, and a URL can belong to a different target than the displayed platform. | Derive all views from validated result rows and add boundary/partial-success tests. |
| AUD-016 | Feature correctness | P2 | HIGH | `src/app/actions/inbox.ts:47-108,110-145,180-203` | Only X mentions and Instagram conversations are polled; replies work only for X; messages never become read and external failures look empty. | Either scope the UI copy to actual support or implement the missing providers/state/error model. |
| AUD-017 | Reliability / AI | P2 | HIGH | `src/lib/ai-sdk.ts:47-255`; all external `fetch` call sites | AI/provider/publish calls lack timeouts and output caps; stream readers do not flush a final buffered SSE event and are not cancelled on client disconnect. | Add shared abort/timeout/byte/token limits, flush/decoded cancellation, and stream tests. |
| AUD-018 | Configuration correctness | P2 | HIGH | `src/lib/ai.ts:53-81` | With only an Anthropic fallback key plus a custom base URL, precedence can select the OpenAI wire format unexpectedly. | Make format selection explicit, validate combinations, and test env matrices. |
| AUD-019 | Configuration / UX | P2 | HIGH | `src/app/actions/platform.ts:33-39`; `src/lib/platform-credentials.ts:61-82`; Accounts `:545-550,670-675` | UI “configured” checks only per-user DB rows although runtime supports env fallback; documented env-only platforms appear unconfigured and Connect is disabled. | Centralize environment-aware status resolution and use it everywhere. |
| AUD-020 | Product correctness | P2 | HIGH | `src/db/schema.ts:54-63`; `src/app/(dashboard)/settings/settings-client.tsx:66-70,418` | Four preference switches persist but no Composer, Assistant, Scheduler, or notification code reads them. | Implement behavior or hide/remove the switches and document the actual product contract. |
| AUD-021 | Persistence / tenancy | P2 | HIGH | `src/db/schema.ts:33-45,104-146`; migrations; `src/lib/signed-request.ts:80-109` | No RLS, no social-account uniqueness/indexes, no post indexes/constraints, multi-step writes are not transactional, and shared callback secrets retain only one owner mapping. | Add database constraints/indexes/RLS as appropriate, transaction/lock tests, and an indexed app/owner mapping for shared webhook secrets. |
| AUD-022 | Storage / privacy | P2 | MEDIUM | `src/app/api/media/route.ts:69-89`; `src/app/api/media/[id]/route.ts:5-39`; schema `:163-173` | Public capability URLs serve immutable database bytes with no quota, cleanup, ownership check, or abuse limit. | Add quotas/rate limits, retention/deletion, content policy, and a deliberate public-asset design. |
| AUD-023 | Product / documentation | P2 | HIGH | `src/app/pricing/page.tsx:16-64`; `src/app/(auth)/signup/page.tsx:26-30`; landing `:169-183,349-410` | Trials, plan limits, teams, approvals, API access, analytics, testimonials, and usage metrics are not implemented or substantiated. | Mark as design-only or implement entitlements, billing, evidence, and legal review before publication. |
| AUD-024 | Documentation / operations | P2 | HIGH | `ROADMAP.md`; `README.md`; docs; `.env.example`; `src/app/api/webhooks/instagram/route.ts:56-74` | SQLite/mock/old roadmap text remains; Instagram setup contradicts itself; webhook verify token is undocumented; the webhook only checks deployment-level credentials despite per-user app credentials; several feature descriptions overstate code. | Rewrite docs from the current implementation, document the credential model, and add an env/setup validation checklist. |
| AUD-025 | Performance / scale | P2 | MEDIUM | `.next/diagnostics/route-bundle-stats.json:3-172`; `src/app/actions/analytics.ts:105-111`; `src/db/index.ts:7-9` | Large client bundles, unbounded analytics reads, repeated session/action queries, no useful query indexes, and an unconfigured pool are credible scale bottlenecks. | Measure with query plans/RUM, add pagination/indexes/pool limits, and reduce client work. |
| AUD-026 | Tooling / quality | P2 | HIGH | `pnpm lint` output; `eslint.config.mjs` | The repository’s declared lint command fails with 11 errors and 27 warnings, including purity/effect and unsafe `any` findings. | Make lint a blocking, reproducible gate and resolve errors before cleanup. |
| AUD-027 | Dependencies | P2 | HIGH | `package.json:12-53`; `pnpm-lock.yaml` | Fourteen direct packages have no source consumer; the lock retains optional SQLite peer artifacts; ESLint 9 is marked deprecated; config names an undeclared package. | Remove unused direct deps, regenerate/frozen-check the lock, and review major updates separately. |
| AUD-028 | Authentication | P2 | MEDIUM | `src/app/actions/auth.ts:32-35,64-181`; `src/proxy.ts:31-65`; `src/lib/session.ts:72-76` | Lockout messages permit account enumeration and account-level DoS; failed-attempt updates race; passwords have no byte-length guard and bcrypt truncates beyond 72 bytes; logout does not revoke a stolen stateless JWT; the IP throttle trusts forwarded headers outside Vercel. | Use generic responses, durable atomic counters, explicit password-byte limits/cost, server-side logout revocation or documented short-lived sessions, and deployment-aware client IP handling. |
| AUD-029 | OAuth / error handling | P2 | HIGH | `src/app/api/connect/[platform]/callback/route.ts:102-131,179-246` | Network failures can escape as 500s, unsupported profile failures can store `"unknown"`, and `APP_URL` is not enforced when absent. | Fail closed with typed errors, require valid account IDs, and validate production origin configuration. |
| AUD-030 | Time / data correctness | P2 | MEDIUM | `src/db/schema.ts:26,44,118-122`; `src/app/(dashboard)/scheduler/scheduler-clients.tsx:18-34` | PostgreSQL timestamps are timezone-naive while the scheduler mixes serialized server dates with client-local parsing. | Use timezone-aware timestamps and one explicit display/calendar timezone contract. |
| AUD-031 | Error handling / observability | P2 | HIGH | `src/app/actions/inbox.ts:73-107`; Assistant route `:146-149,208-214`; OAuth routes | Several failures are swallowed as empty/success-like states, while other route/action errors have no timeout or structured context. | Define typed error states, structured logs/metrics, and alerting for publish/AI/webhook failures. |
| AUD-032 | Client concurrency | P2 | MEDIUM | `src/app/(dashboard)/inbox/inbox-client.tsx:62-69`; settings `:159-160`; assistant `:192-203` | Missing effect dependencies, un-cancelled async work, and optimistic toggles allow stale responses and UI/database divergence. | Add abort/generation guards and reconcile state from the server after failures. |
| AUD-033 | Security hardening | P2 | MEDIUM | `next.config.ts:15-18,35-46`; external API URLs | CSP relies on `unsafe-inline`, provider tokens appear in some query strings, and webhook bodies have no explicit size cap. | Tighten CSP with nonces, minimize token-bearing URLs, and cap/stream webhook bodies. |
| AUD-034 | Dead files | P3 | HIGH | `src/lib/mock-data.ts`; three unused motion components; five starter SVGs | No internal imports, dynamic loading, configuration, tests, or framework convention uses these files. | Remove the four source modules after external-consumer check; remove public SVGs after checking external URLs. |
| AUD-035 | Dead exports/actions | P3 | HIGH | `credentials.ts`, old `publish.ts` actions, `generatePostAction`, AI/platform helpers | Build server-reference manifest and repository searches show no live consumer for these surfaces. | Remove dead action/service surface in a separate cleanup change; retain internal helpers still used by active code. |
| AUD-036 | Dead symbols/config | P3 | HIGH | Composer/Accounts/Scheduler imports; `globals.css:127-166`; `next.config.ts:54` | Exact unused imports/constants, unused CSS blocks, and an undeclared optimize-package token remain. | Remove after visual/build verification; do not delete live design-system primitives solely because subexports are unused. |
| AUD-037 | Placeholder UI / accessibility | P3 | MEDIUM | AppShell `:71-92`; Analytics `:48-52`; Scheduler `:80-115`; motion components | Search, notifications, export, optimal-time scores, and several icon-only controls are nonfunctional or lack accessible labels/reduced-motion handling. | Implement or remove each placeholder and add an accessibility pass. |
| AUD-038 | Local/generated cleanup | P3 | HIGH | `data/hilbras.db*`, `.zcode/`, `.freebuff/` | These are ignored local/tool artifacts; the SQLite family is demonstrably pre-PostgreSQL. | Back up and manually verify before deleting; never treat generated metadata as tracked source. |
| AUD-039 | Duplicate architecture | P3 | MEDIUM | Credential/publish/terminal-state/relative-time/provider-resolution helpers | Several implementations duplicate the same behavior and can drift. | Consolidate around one server-side DAL/helper per invariant. |
| AUD-040 | Commented/TODO audit | P4 | HIGH | Entire repository | No executable commented-out blocks and no genuine TODO/FIXME/HACK/XXX markers were found; one justified ESLint suppression exists. | Keep this as a clean baseline; track incomplete work in issues/docs rather than dead comments. |

## Critical Findings

There are **no confirmed P0 findings** in the inspected source. The absence of a P0 does not mean the application is safe to deploy: several P1 issues can publish to live external accounts, expose credentials, incur unbounded cost, or mishandle personal-data deletion.

The immediate stop-ship set is AUD-001 through AUD-013, with AUD-011 requiring an operational decision about whether the local workspace has been shared.

## High Severity Findings

### AUD-001 — Composer schedule mode can publish immediately

- **Category:** Correctness
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/app/(dashboard)/composer/page.tsx:190-218`
- **Evidence:** `scheduledAt` is assigned only when `scheduleMode && scheduledDate`; otherwise it is `undefined`, the code saves a draft, and execution continues to `publishToAllNowAction`. The button is enabled with an empty date. The result of `createPostAction` is never checked before publishing or displaying scheduled success.
- **Impact:** A user can click a button labelled “Schedule for …” and publish immediately. A failed database save can also be followed by a live publish, leaving no durable post record. A failed scheduled save can be reported as success.
- **Recommendation:** Treat schedule mode as a separate state machine. Require a valid local date/time, construct and validate the date, verify `saveResult.success`, and return before any immediate publish on any save failure.

### AUD-002 — Registry/UI promises more publishers than exist

- **Category:** Feature correctness
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/lib/platforms.ts:14-25`; `src/lib/publish.ts:836-859`; Accounts `:411-506`; Composer `:499-537`
- **Evidence:** The registry has ten IDs. `publishForUser` has cases only for Instagram, Facebook, X, Threads, and Telegram; the default returns `Publishing not yet supported`. The UI nevertheless renders all registry entries and enables connected entries.
- **Impact:** LinkedIn, TikTok, YouTube, Pinterest, and Reddit accounts can appear connected and selectable, then fail at publish time. Users cannot distinguish a valid connection from a publish-capable connection.
- **Recommendation:** Add explicit capabilities such as `canConnect`, `canPublish`, supported media, and account model. Hide/disable unsupported targets in Composer and label them accurately in Accounts/docs. Do not delete registry entries until the product decision is made.

### AUD-003 — Shared AI spend is effectively unbounded

- **Category:** Security / cost
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/app/actions/auth.ts:47-96`; `src/app/actions/ai.ts:109-211`; `src/app/api/assistant/route.ts:77-110`
- **Evidence:** Signup creates an account without email verification, invitation, or plan enforcement. Only `/api/assistant` calls `consumeRateLimit`; Composer improve/hashtags and inbox reply suggestions have no quota. The Assistant limiter fails open if the database limiter fails, and memory/summarization can make additional provider calls after the main request.
- **Impact:** Any newly created account can repeatedly consume the built-in provider key. The application has no demonstrated per-plan usage limits, output-token budget, or global spend circuit breaker.
- **Recommendation:** Gate all model entry points through one server-side quota/spend service, cap input and output tokens, add account/IP/global limits, require verification or an invite for server-funded models, and use a bounded fallback or temporary fail-closed policy when the limiter is unavailable.

### AUD-004 — AI provider SSRF protection is bypassable through redirects/rebinding

- **Category:** Security
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/lib/net-guard.ts:5-16,80-120`; `src/lib/ai-sdk.ts:61-68,96-103,166-174,208-216`; `src/app/actions/ai-providers.ts:258-305`
- **Evidence:** The guard resolves and checks the initial hostname, but all provider requests use default `fetch` redirect behavior. A public hostname can redirect to `127.0.0.1`, `169.254.169.254`, or another private address without a second guard call. The source itself documents the DNS-rebinding TOCTOU gap. Upstream error text is returned to the caller.
- **Impact:** An authenticated user can use a public redirector or rebinding DNS server to make the Hilbras server fetch internal services and return fragments of responses.
- **Recommendation:** Use an egress proxy/allowlist or a dispatcher that pins the validated address, set redirects to manual and validate every hop, and keep response bodies generic. Treat `ALLOW_PRIVATE_AI_URLS=1` as a high-risk production setting.

### AUD-005 — Data deletion and account-rights promises are not implemented

- **Category:** Privacy / security
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/app/api/connect/threads/delete/route.ts:40-67`; `src/app/privacy/page.tsx:123-139`; repository search for account deletion/export
- **Evidence:** The Meta callback deletes matching `social_accounts` rows only. It does not delete posts, media, stored credentials, AI providers, preferences, chat sessions/messages, memories, or backups. No account-deletion action, route, UI, or operational runbook exists, despite the privacy page promising deletion within 30 days and rights to export/delete data.
- **Impact:** The callback can tell Meta that data was deleted while personal data remains in the database. The published policy and actual retention/deletion behavior are materially different.
- **Recommendation:** Define the data inventory and deletion contract first. Implement authenticated account deletion/export, tenant-scoped deletion of all related rows, media/storage cleanup, backup/retention handling, and an accurate Meta callback response.

### AUD-006 — Platform client secrets are returned to the browser

- **Category:** Security
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/app/actions/platform.ts:25-30`; `src/app/(dashboard)/accounts/page.tsx:218-226`; generated server-reference manifest
- **Evidence:** `getPlatformCredentials` decrypts and returns both `clientId` and `clientSecret`. The live Accounts server action is present in the generated server-reference manifest, and the client stores the secret in React state and places it in an input value. `type="password"` only masks display; it does not protect the value from browser JavaScript.
- **Impact:** A browser extension, XSS, compromised dependency, or devtools user can read the user’s OAuth client secret. This is unnecessary exposure of a credential that is only needed server-side.
- **Recommendation:** Return only `hasClientId`, `hasClientSecret`, masked display values, and a credential version/timestamp. Require the user to re-enter a secret to replace it; never send decrypted secrets to a client component.

### AUD-007 — Scheduler has timeout and duplicate-publication failure modes

- **Category:** Async / correctness
- **Severity / confidence:** P1 / HIGH for the code path; MEDIUM for the exact Vercel limit
- **Location:** `src/lib/scheduled-posts.ts:24-35,69-106,145-198`; `src/lib/publish.ts:632-648`; `vercel.json`
- **Evidence:** The runner processes ten posts sequentially. A Threads video can block for up to 60 seconds, so the batch can approach ten minutes before overhead, while no route `maxDuration` or elapsed-time budget is configured. A post in `publishing` is reclaimed after ten minutes using only `publishedAt`; there is no lease/claim token. `finalize` updates by post ID without checking the claim.
- **Impact:** A serverless timeout can leave rows in `publishing`, and a later run can reclaim/re-publish a post that already reached a platform but was not finalized. Two runs can also overwrite one another’s terminal results.
- **Recommendation:** Bound each run by a measured deadline and platform timeout, use a unique claim/lease ID and conditional finalization, and choose/document an idempotency strategy for external publishes. Add crash/recovery integration tests.
- **Status (post-remediation):** Remediated. `src/lib/scheduled-posts.ts` now claims each post with a UUID `claim_id` and a 5-minute `claim_expires_at` lease (migration `0006_scheduler_claims`), finalizes conditionally on still owning the claim, bounds runs with a 100s deadline and a 60s per-post provider timeout under a 120s route `maxDuration`, and records `dispatch_started_at` so an expired claim that already reached a platform is failed with an explicit unknown-outcome result instead of being re-queued. Idempotency strategy: at-most-once for dispatched-but-uncertain posts (never blindly retried), at-least-once only for claims that provably never dispatched. Crash/overlap/timeout recovery is covered by `tests/integration/scheduler.test.ts`.

### AUD-008 — OAuth provider protocol configuration is only partially implemented

- **Category:** OAuth correctness
- **Severity / confidence:** P1 / MEDIUM
- **Location:** `src/lib/platforms.ts:47-58,103-115,160-171,275-286`; callback `src/app/api/connect/[platform]/callback/route.ts:96-131`; preflight `src/lib/platform-app-check.ts:111-127`
- **Evidence:** The registry declares `tokenAuth: "basic"` for X and Reddit, but the callback sends client credentials in a form body for every non-GET exchange. The registry declares `usesPkce`, but no code branches on it. The preflight always uses POST/body credentials and ignores `tokenMethod`. X requests `offline.access`; the callback writes `refresh_token`, but no current code reads `refreshTokenEnc`, and X is not in the Meta refresh map.
- **Impact:** X/Reddit token exchange may fail in production, and long-lived X connections cannot be refreshed. The UI can still report a connection/configuration as valid because preflight failures are treated as “unverified.”
- **Recommendation:** Build a provider protocol matrix (method, auth style, PKCE, scopes, response shape, refresh semantics) and test each against a mocked and, where appropriate, sandbox provider. Do not infer support from registry metadata alone.

### AUD-009 — Client-supplied publish outcomes corrupt post state and permit unsafe links

- **Category:** Security / data integrity
- **Severity / confidence:** P1 / HIGH for the code path
- **Location:** `src/app/actions/posts.ts:117-136`; `src/app/(dashboard)/composer/page.tsx:212-218`; `src/app/(dashboard)/analytics/analytics-clients.tsx:71-77`; Composer results `:469-480`
- **Evidence:** `recordPublishOutcome` is a live client-invokable server action. It validates shape but trusts `success` and `url` supplied by the client, then updates the caller’s post. The runtime schema accepts arbitrary URL strings, while Analytics renders the stored value as an `href`. A user can mark a draft/scheduled post published without a server-side publish and store a `javascript:`, `data:`, or other untrusted URL.
- **Impact:** Post status, analytics, and failure explanations can be falsified. Unsafe URLs create a stored-link/script-injection risk in any future account-sharing/admin view and are unnecessary even in the current single-user UI.
- **Recommendation:** Perform terminal-state transitions only inside a server-side publish service. Have the server generate/validate result URLs against an `https:` and platform-host allowlist; never accept client assertions as authoritative.
- **Status (post-remediation):** Remediated. `recordPublishOutcome` and its `outcomeInput` schema were removed from `src/app/actions/posts.ts` (zero callers), so no client-invokable action can write a terminal publish state; the Composer persists server-produced connector results through `publishComposerDraftAction`, and the scheduler finalizes only under its claim. Result-URL allowlisting was not implemented separately because no client-supplied URL path remains.

### AUD-010 — Scheduled publishing is exposed as an unprotected state-changing GET

- **Category:** Security
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/app/api/cron/publish-scheduled/route.ts:34-53`; session cookie `src/lib/session.ts:60-67`
- **Evidence:** The route accepts `GET`, falls back to the signed-in user when no cron secret is supplied, and has no Origin/CSRF check. The session cookie is SameSite=Lax, which is sent on a cross-site top-level GET navigation. The handler can refresh tokens and publish due posts.
- **Impact:** A malicious page can cause a logged-in user’s browser to navigate to the endpoint and trigger that user’s scheduled posts. The endpoint is also easy to abuse repeatedly by any authenticated session.
- **Recommendation:** Make manual triggering `POST` with a same-origin/CSRF check, retain a separate secret-authenticated cron path, and add a one-time/idempotency guard. Do not rely on SameSite alone for a mutating GET.

### AUD-011 — Populated secrets exist in the local workspace

- **Category:** Secret management
- **Severity / confidence:** P1 / HIGH for workspace exposure; not a committed-source finding
- **Location:** `.env.local` (ignored by `.gitignore:34-38`)
- **Evidence:** The file contains populated values for session signing, encryption, database, AI-provider, and webhook variables. No values were found in tracked source/docs/migrations or the production bundle, and Git confirms the file is untracked. A provider-looking `GROQ_API_KEY` is also present but not referenced by application code. The inspected file mode was group/other-readable (`0664`).
- **Impact:** If this workspace, shell history, backups, or agent logs have been shared, the credentials should be considered exposed. On a multi-user host, local group/other read access is an additional exposure. Rotating `ENCRYPTION_KEY` invalidates stored encrypted credentials and requires a planned re-encryption/reconnect process.
- **Recommendation:** Restrict the file to the owning user (for example, mode `0600`), rotate all populated secrets if the workspace has been shared, invalidate sessions/tokens, remove unused local keys, and use a secret manager. Do not print or commit the values.

### AUD-012 — There is no automated test or CI safety net

- **Category:** Quality / operational
- **Severity / confidence:** P1 / HIGH
- **Location:** `package.json:5-10`; repository root
- **Evidence:** No `*.test.*`, `*.spec.*`, `__tests__`, `e2e`, Jest/Vitest/Playwright/Cypress, `.github/`, or equivalent CI configuration exists. `/coverage` is ignored, but no coverage producer or threshold exists.
- **Impact:** Security, OAuth, scheduler, encryption, and publishing changes can pass compilation while breaking behavior. The roadmap’s “verified” claims are not reproducible from the repository.
- **Recommendation:** Add a minimal test stack and CI first: pure unit tests, PostgreSQL integration tests, mocked external API contract tests, and a small set of Playwright flows for login, schedule, publish, and connection health.

### AUD-013 — One rejected platform can lose the results of other publishes

- **Category:** Async / data integrity
- **Severity / confidence:** P1 / HIGH
- **Location:** `src/lib/publish.ts:869-878`; `src/lib/scheduled-posts.ts:176-196`
- **Evidence:** `publishToAllForUser` uses `Promise.all`. If one connector rejects before all others settle, the caller receives one rejection. The scheduler catches it and records a single synthetic failure result, even though sibling promises may already have published or may still publish after the catch.
- **Impact:** A post can be marked failed despite a successful platform, and a later retry can duplicate a live post. The UI cannot show accurate per-platform outcomes.
- **Recommendation:** Use `Promise.allSettled`, convert every rejection into a platform result, and finalize only after all attempts have settled. Add a connector mock that rejects one target while succeeding another.

## Medium Severity Findings

The following findings are supported by code and should be addressed after the P1 stop-ship items. Exact locations and recommended directions are consolidated in AUD-014 through AUD-033 above.

### Publishing and product capability drift

- **Media and account capabilities (AUD-014):** Instagram always sends `media_type: "IMAGE"`; X’s publisher accepts only text; Facebook selects the first page and sends a URL field rather than a complete media/account implementation; TikTok/YouTube/Pinterest/Reddit have no publisher. The registry should encode these differences rather than relying on prose.
- **Incomplete inbox (AUD-016):** The page says comments, mentions, and DMs across every platform, but only X mentions and Instagram conversations are fetched, only X replies are sent, all messages are perpetually unread, and provider errors are converted to empty arrays.
- **Inert preferences (AUD-020):** `autoHashtags`, `adaptTone`, `autoSchedule`, and `engagementNotifications` are stored but never consumed by feature code.
- **Plan/marketing mismatch (AUD-023):** There is no billing, entitlement, team, approval, API-access, trial, or engagement-notification implementation behind the public pricing/landing claims. Treat hard-coded testimonials and metrics as product/legal content requiring owner approval.

### Data and configuration correctness

- **Analytics (AUD-015):** `getAnalyticsData` only loads `status = "published"` rows, so all-failed posts do not contribute to failed outcome counts. The platform breakdown uses the target list rather than successful result rows, and the recent-post label can describe one platform while linking another.
- **Built-in provider selection (AUD-018):** The conditional expression at `src/lib/ai.ts:63-69` lets the presence of `HILBRAS_AI_BASE_URL` force OpenAI format even when the only configured legacy key is Anthropic. Make the format explicit and test all combinations.
- **Environment-aware credentials (AUD-019):** Runtime resolves user DB values then env values, but Accounts/Composer status checks inspect only DB rows. Env-only deployments are therefore presented as unconfigured.
- **Database integrity (AUD-021):** Migrations show `isRLSEnabled: false`; `social_accounts` has no uniqueness/index for user/platform; posts have no status/date indexes; AI defaults have no database-enforced single-default invariant. Reconnect, Telegram connect, provider selection, and post finalization use multi-step writes without transactions. Public Threads callbacks also load/decrypt every stored secret on every request and deduplicate equal secrets to one owner, so shared app secrets can attribute a valid callback to the wrong tenant.
- **Timezone semantics (AUD-030):** `timestamp` columns are timezone-naive, while the browser creates local dates and the Scheduler reparses an ISO week boundary in local time. A user outside the server timezone can see a post on the wrong day or schedule it at the wrong instant.

### Reliability, error handling, and security hardening

- **AI and external HTTP controls (AUD-017):** Provider, publishing, OAuth, inbox, and credential-probe requests generally have no `AbortSignal.timeout`. OpenAI output has no default cap, streams do not flush a final non-newline-terminated SSE buffer, and the route does not cancel the upstream reader when the browser disconnects.
- **OAuth failure handling (AUD-029):** Callback fetches are not surrounded by consistent typed error handling; profile failure can fall through to `"unknown"` for several platforms; `APP_URL` is documented as required but not enforced. `requestOrigin` itself correctly gives `APP_URL` priority through `originFromHeaders`; the risk is the unvalidated fallback when `APP_URL` is absent, not the apparent function-name mismatch.
- **Error/observability (AUD-031):** Inbox and memory paths swallow errors, some actions return success-like empty data, and publish/token/webhook failures are only sporadic `console` calls. There are no metrics or alerts for duplicate publishes, AI spend, token failures, or stuck `publishing` rows.
- **Authentication abuse controls (AUD-028):** The lockout message becomes distinguishable after repeated failures, failed-attempt counters are read-modify-write rather than atomic, and a proxy IP throttle based on forwarded headers is not safe for arbitrary self-hosted deployments. Login/password schemas also lack maximum byte lengths; bcrypt cost 10 is below a current hardening target, and bcrypt’s 72-byte input limit means long Unicode passwords can share an effective prefix. Ordinary logout only deletes the cookie: a copied stateless JWT remains valid until expiry and can be refreshed by the Proxy. Consider progressive delay, explicit byte limits, a stronger password KDF/cost, and server-side/session-version revocation if stolen-cookie logout resistance is required.
- **Client races (AUD-032):** Inbox suggestions have a missing `selected` dependency; settings toggles optimistically diverge if the action fails; Assistant refresh failures can turn a successful stream into an error state. Add cancellation/generation guards.
- **Security headers and transport metadata (AUD-033):** CSP still permits `unsafe-inline` for scripts/styles, provider access tokens are placed in some query strings, and the Instagram webhook reads an unbounded request body. These are defense-in-depth issues, not evidence of a current exploit by themselves.
- **Public media (AUD-022):** Public UUID URLs are a deliberate capability model for Meta, but there is no quota, deletion, retention, or abuse limit. Treat the design as an explicit public-storage decision rather than an accidental anonymous file server.

## Low Severity Findings

- **Dead files (AUD-034):** Four source modules and five default public SVGs have no internal references. See the deletion decision table below.
- **Dead action/service surface (AUD-035):** Generic credential CRUD, old FormData publish actions, `generatePostAction`, and several AI/platform helpers are absent from the generated server-reference manifest. They should be removed in a cleanup change, not confused with live internal helpers.
- **Dead imports/constants/CSS (AUD-036):** Lint and source searches identify unused imports, `HASHTAG_SUGGESTIONS`, an unused `getWeekRange` offset, `borderWidth`, `.glass-subtle`, `.stagger-in`, and unused keyframes. Retain reusable UI subcomponents unless the design-system owner approves removing their public exports.
- **Local artifacts (AUD-038):** The SQLite files predate the PostgreSQL migration and are ignored, but may contain local data. Back them up and confirm no process uses them before deletion.
- **Placeholder UI/accessibility (AUD-037):** AppShell search and notification controls, Analytics Export, hard-coded “AI Optimal Times,” and several icon buttons are nonfunctional or lack labels. Motion components do not consistently honor reduced-motion preferences.
- **Tooling drift (AUD-027/AUD-036):** `next.config.ts` names `@radix-ui/react-icons`, which is not declared or locked; the project has no Node version file/engines; and the declared ESLint version is marked deprecated in the lockfile.

## Confirmed Bugs

| ID | Severity | Location | Bug | Impact | Evidence | Fix Direction |
|---|---|---|---|---|---|---|
| B-001 / AUD-001 | P1 | Composer `:190-218` | Schedule mode with missing date reaches immediate publish; save errors ignored. | Accidental live posts and missing/incorrect queue records. | `scheduledAt` becomes `undefined`, then `publishToAllNowAction` runs. | Validate mode-specific inputs and stop on save failure. |
| B-002 / AUD-002 | P1 | Registry/publisher/UI | Five registry platforms are presented as publishable but have no publisher. | User-visible publish failures and false product readiness. | Dispatcher default returns “not yet supported”; UI enables all connected registry IDs. | Add explicit capability matrix and gate UI. |
| B-003 / AUD-008 | P1 | OAuth registry/callback | Basic-auth and provider exchange metadata is not honored. | X/Reddit connections may fail; refresh lifecycle is incomplete. | `tokenAuth`/`usesPkce` have no read sites; callback always uses body POST for non-GET. | Implement/test a provider matrix. |
| B-004 / AUD-008 | P1 | X token lifecycle | `offline.access` refresh token is written but never used. | Connections eventually require manual reconnect. | `refreshTokenEnc` appears only in schema/callback; token maintenance covers only Meta endpoints. | Implement refresh/rotation or stop claiming durable X support. |
| B-005 / AUD-014 | P2 | Instagram publisher | Video URLs are always sent as `IMAGE`. | Reels/video posts fail despite registry/UI support. | `media_type: "IMAGE"` is unconditional. | Detect/validate media type and implement video container flow. |
| B-006 / AUD-015 | P2 | Analytics | Failed targets and all-failed posts are misrepresented. | Dashboard/analytics reports false reach/outcome data. | Breakdown uses `post.platforms`; query filters to published rows only. | Calculate from validated result arrays. |
| B-007 / AUD-016 | P2 | Inbox | Only two read paths and one reply path exist; messages never become read. | Product copy and UX overstate support. | `fetchXMessages`/`fetchInstagramMessages`; `unread: true`; X-only `sendReply`. | Scope UI or implement full support/state. |
| B-008 / AUD-017 | P2 | AI SDK | Final unterminated SSE buffer can be dropped. | Assistant response can lose the last token(s). | Parser exits without processing `buffer` after EOF. | Flush decoder/buffer and test fragmented/final events. |
| B-009 / AUD-019 | P2 | Accounts/Composer | Env-only credentials are invisible to UI checks. | Documented self-hosted setup cannot connect from the UI. | DB-only status queries vs env fallback resolver. | Centralize status resolution. |
| B-010 / AUD-020 | P2 | Settings | Preference switches have no behavior. | Users are told a feature exists when it is inert. | Only schema/UI/action references exist. | Implement or remove the controls. |
| B-011 / AUD-005 | P1 | Meta deletion/privacy | Deletion callback removes only a connection. | Regulatory/data-retention mismatch. | One `social_accounts` delete; no account deletion route. | Implement complete tenant deletion. |
| B-012 / AUD-009 | P1 | Publish outcome/Analytics | Client can fabricate status and store unsafe URL. | Data integrity and stored-link risk. | Live action accepts arbitrary result fields and renders URL. | Server-authoritative transition + URL allowlist. |
| B-013 / AUD-010 | P1 | Cron route | State-changing GET lacks CSRF defense. | Cross-site navigation can publish due posts. | Session fallback on GET; no Origin check. | POST + CSRF/origin validation. |
| B-014 / AUD-026 | P2 | Lint output | Declared quality gate is red. | Broken patterns can ship. | 11 errors/27 warnings. | Fix and enforce in CI. |
| B-015 / AUD-027 | P2 | Dependencies | Unused direct packages remain in production graph. | Install/build/audit surface and maintenance cost. | No source/config imports; history shows React Query was removed then restored for lockfile alignment. | Remove and regenerate lockfile. |
| B-016 / AUD-018 | P2 | Built-in provider config | Base URL can force wrong API format. | AI calls fail with valid Anthropic configuration. | Conditional precedence in `getBuiltinProviderConfig`. | Make format explicit/test matrix. |
| B-017 / AUD-034 | P3 | Dead source/assets | Unused mock/motion/starter files remain. | Maintenance and repository noise. | Whole-repo search and initial-only history. | Remove after external-consumer check. |
| B-018 / AUD-024 | P2 | Docs/config | Roadmap/setup docs contradict implementation and omit webhook env. | Operators and users configure the wrong system. | SQLite/mock text, Instagram contradiction, missing token. | Rewrite and validate docs. |

## Potential Bugs

| ID | Severity | Location | Potential failure | Confidence | Why it remains “potential” |
|---|---|---|---|---|---|
| AUD-007 | P1 | Scheduler | Timeout/reclaim causes duplicate live posts or overwritten results. | MEDIUM | Depends on platform latency, Vercel plan timeout, and crash timing; code path is confirmed. |
| AUD-013 | P1 | `Promise.all` publish path | One rejection causes sibling side effects to be misreported. | HIGH for path / MEDIUM for frequency | Requires a connector/DB rejection; no live provider failure was injected. |
| AUD-017 | P2 | External fetch/stream paths | Hanging providers or client disconnects consume resources/spend. | HIGH | Depends on hostile/slow upstream and serverless cancellation behavior. |
| AUD-021 | P2 | DB writes | Concurrent reconnects/default selection create duplicate rows/defaults. | MEDIUM | Requires concurrent requests; no database concurrency test exists. |
| AUD-028 | P2 | Login lockout | Account enumeration/DoS and lost counter updates under races. | MEDIUM | Requires distributed/concurrent login traffic. |
| AUD-029 | P2 | OAuth origin/callback | Missing `APP_URL`/host manipulation can produce a bad redirect URI or 500. | MEDIUM | Deployment proxy behavior and provider registration determine exploitability. |
| AUD-030 | P2 | Timestamp/calendar handling | Posts appear on the wrong day around timezone boundaries. | MEDIUM | Current server is likely UTC; user/server timezone combinations were not run. |
| AUD-008 (state subset) | P2 | OAuth state | State is unsigned and only checks `userId`; PKCE cookie partially mitigates CSRF. | MEDIUM | Provider/browser flow and cookie behavior were not live-tested; do not call it confirmed account takeover. |
| AUD-037 | P2 | Media/storage | Repeated uploads can exhaust DB/bandwidth or expose assets by leaked URL. | MEDIUM | Requires traffic, URL leakage, or abusive client behavior. |
| AUD-025 | P2 | Queries/bundle/pool | Large datasets or serverless instances create latency/connection exhaustion. | MEDIUM | No production dataset, query plans, or load test exists. |
| AUD-032 | P2 | Client effects | Late async responses overwrite newer UI state. | MEDIUM | Requires rapid navigation/toggle interactions; lint confirms missing dependency. |

## Dead Files

### Evidence-based deletion decisions

The following table deliberately includes the checks required for a removal recommendation. “No import” was not used as the sole criterion.

| File | Classification | Evidence | References checked | Tests / build / config | Git/history evidence | Deletion risk | Confidence | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `src/lib/mock-data.ts` | **SAFE TO REMOVE** | Contains invented stats/activity and no import; current Dashboard imports real actions. | Static imports, dynamic imports, route/config references, all repo `rg` searches. | No tests reference it; absent from build manifest; no config/script reference. | Added in initial `ba54970`; unchanged; current plan says replace with real data. | External demo/private branch could import a private module. | HIGH internally / MEDIUM external | Remove after one external-consumer check. |
| `src/components/motion/animated-counter.tsx` | **SAFE TO REMOVE** | Only self-definition; no module-path import or dynamic import. | Whole source tree and generated output. | No tests/config/build references. | Initial-release-only path history. | Could be a reserved design-system primitive. | HIGH | Remove or move to a separately owned component package. |
| `src/components/motion/perspective-card.tsx` | **SAFE TO REMOVE** | Only self-definition; no consumer. | Whole source tree and generated output. | No tests/config/build references. | Initial-release-only path history. | Reusable visual primitive with no current owner. | HIGH | Remove after visual/design-owner check. |
| `src/components/motion/sparkles.tsx` | **SAFE TO REMOVE** | No import of this module; other `Sparkles` symbols are Lucide icons. | Whole source tree, dynamic imports, route references. | No tests/config/build references. | Initial-release-only path history. | Name collision can create false positives; module-path search resolves it. | HIGH | Remove. |
| `public/file.svg` | **LIKELY SAFE TO REMOVE** | Generic starter icon; no internal URL/reference. | Source, docs, CSS, config, route output. | No build/config/test reference. | Initial-release-only path. | External users could hot-link the public URL. | HIGH internal / MEDIUM external | Check CDN/access logs, then remove. |
| `public/next.svg` | **LIKELY SAFE TO REMOVE** | Generic Next logo; no internal reference. | Same checks. | Same checks. | Initial-release-only path. | Public URL compatibility. | HIGH internal / MEDIUM external | Check external URLs, then remove. |
| `public/vercel.svg` | **LIKELY SAFE TO REMOVE** | Generic Vercel triangle; no internal reference. | Same checks. | Same checks. | Initial-release-only path. | Public URL compatibility. | HIGH internal / MEDIUM external | Check external URLs, then remove. |
| `public/window.svg` | **LIKELY SAFE TO REMOVE** | Generic starter icon; no internal reference. | Same checks. | Same checks. | Initial-release-only path. | Public URL compatibility. | HIGH internal / MEDIUM external | Check external URLs, then remove. |
| `public/globe.svg` | **LIKELY SAFE TO REMOVE** | Generic starter icon; no internal reference. | Same checks. | Same checks. | Initial-release-only path. | Public URL compatibility. | HIGH internal / MEDIUM external | Check external URLs, then remove. |
| `data/hilbras.db`, `data/hilbras.db-wal`, `data/hilbras.db-shm` | **REQUIRES MANUAL VERIFICATION** | SQLite files predate the PostgreSQL migration; current `db/index.ts` uses `pg`. | Whole-repo search; no current code opens `data/`. | `.gitignore` ignores them; no build/test/config reference. | Migration commit `fb7f810` changed runtime to Postgres. | May contain local user data; WAL must be handled coherently. | HIGH legacy / MEDIUM deletion | Stop local processes, back up, verify no local consumer, then remove as a set. |
| `.zcode/plans/...`, `.freebuff/project-id` | **UNKNOWN / manual** | Local tool metadata, ignored and not application source. | No runtime references. | No build/test/config references. | Local artifacts, not tracked product history. | Tool owner may rely on them. | LOW/MEDIUM | Leave or purge according to local-tool policy; do not include in product cleanup commit. |

### Files that look suspicious but must not be deleted

| File | Classification | Reason |
|---|---|---|
| `src/proxy.ts` | **DO NOT REMOVE** | Next 16 Proxy convention; build emits Proxy/Middleware and route protection depends on it. |
| `src/app/docs/template.tsx` | **DO NOT REMOVE** | App Router template convention; it deliberately replays docs navigation animation. |
| `drizzle/0002_cynical_master_mold.sql` | **DO NOT REMOVE** | Suspicious generated name, but it creates the live `media_assets` table and is in the migration journal. |
| `drizzle/meta/*.json` | **DO NOT REMOVE** | Generated metadata/snapshots are part of migration history and schema verification. |
| `src/app/api/media/[id]/route.ts` | **DO NOT REMOVE** | Public route is required for Meta to fetch uploaded media; not called by an internal import. |
| `src/app/api/webhooks/instagram/route.ts` | **DO NOT REMOVE** | Registered externally with Meta; no internal import is expected. |
| `src/app/api/cron/publish-scheduled/route.ts` | **DO NOT REMOVE** | Referenced by `vercel.json` and the Scheduler/manual trigger. |

## Dead Code

### Dead modules and files

See the deletion table above. The four source candidates are `mock-data.ts`, `animated-counter.tsx`, `perspective-card.tsx`, and `sparkles.tsx`. The five public SVGs are likely scaffold residue but require an external-URL check.

### Dead server-action surface

The current build server-reference manifest confirms the following are not live client action references:

- `src/app/actions/credentials.ts`: `saveCredentialAction`, `deleteCredentialAction`, `getCredentialsAction`; retain `getCredentialValue` because `platform.ts` imports it internally.
- `src/app/actions/publish.ts`: old FormData `publishPostAction`, `publishToAllAction`, and `publishPostNowAction`; retain the live `publishToAllNowAction` used by Composer.
- `src/app/actions/ai.ts`: `generatePostAction`; Composer currently uses `improvePostAction` and `generateHashtagsAction`.
- Cascading service exports such as `src/lib/publish.ts:885`’s `publishPost` and the generation wrappers in `src/lib/ai.ts`/`ai-sdk.ts` become removable only after the dead actions are removed and a final external-consumer search is complete.

## Unused Exports

### Runtime and internal-only exports

High-confidence runtime symbols with no current external consumer include:

- `resolveProviderForUser`, `streamChat` in `src/lib/ai.ts`, `getAvailableModels`, `getProviderStatus`
- `getPlatform` and `platformCredentialsConfigured` in `src/lib/platforms.ts`
- `generateEncryptionKey` in `src/lib/crypto.ts`
- `platformMeta` in `src/components/platform-icon.tsx`
- `isBlockedAddress`, `readProviderError`, `platformCredentialKeys`, and `parseSignedRequest` are used internally but needlessly exported
- `MAX_MEMORIES` is used internally but exported without a consumer

Schema type aliases such as `UserPreferences`, `StoredCredential`, `AiProvider`, `MediaAsset`, and `ChatMessageRow` have no current external imports, but they are conventional Drizzle type API and should not be deleted solely on that basis. UI subcomponents such as `CardFooter`, `AvatarImage`, `DialogTrigger`, and `DialogClose` are also reusable design-system surface; remove only with owner approval.

### Unused imports/constants/CSS

The lint/TypeScript no-unused pass found:

- Accounts: `Link`, `Card`, `CardContent`, `CardHeader`, `PlatformId`, `isTesting`
- Composer: `Eye`, `ChevronDown`, `StaggerChildren`, `staggerItem`, `HASHTAG_SUGGESTIONS`
- Dashboard client: `Badge`, `ActivityIcon`
- Inbox page: `Sparkles`
- Scheduler: `ChevronLeft`, `ChevronRight`, unused map index
- `check-connections`: unused `req`
- Landing: `Check`, `Zap`
- `AnimatedBorder`: unused `borderWidth`; `MagneticButton`: unused imports
- `ai.ts`: ignored `opts` parameters
- `globals.css`: `.glass-subtle`, `.stagger-in`, `fadeSlideUp`, and `shimmer` have no current consumers

The Composer `eslint-disable-next-line @next/next/no-img-element` at `:372` is a justified, localized suppression for an arbitrary user-pasted preview URL; it is not a blanket quality suppression.

## Unused Dependencies

### Direct dependencies with no application consumer

The following were checked against static imports, dynamic imports, re-exports, scripts, Next config, and framework conventions. `react-dom` is intentionally retained as a Next/React peer even though application source does not import it directly.

| Dependency | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| `@hookform/resolvers` | Unused direct | No import/resolver; no form library usage. | Bundle/install/lock surface. | Remove with `react-hook-form`. |
| `@radix-ui/react-checkbox` | Unused direct | No import or component file. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-collapsible` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-dropdown-menu` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-progress` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-scroll-area` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-select` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-separator` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-slider` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-tabs` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@radix-ui/react-toggle` | Unused direct | No import/component. | Unnecessary UI dependency. | Remove. |
| `@tanstack/react-query` | Unused direct | No import/provider/query client. History shows it was removed as unused, then restored only to match the lockfile. | Unnecessary runtime graph. | Remove and regenerate the lockfile. |
| `react-hook-form` | Unused direct | No `useForm`/import; forms use server actions/native controls. | Unnecessary runtime graph. | Remove. |
| `zustand` | Unused direct | No store/import; documentation still claims it is active. | Unnecessary runtime graph and stale docs. | Remove or implement a real store. |

### Dependency/tooling review items

| Dependency/artifact | Status | Evidence | Risk | Recommendation |
|---|---|---|---|---|
| `better-sqlite3` / `@types/better-sqlite3` in lock | Stale optional-peer residue, not a direct import | Current runtime is Postgres; `pnpm why` attributes them to Drizzle’s optional peer graph; SQLite direct dependency was removed in `fb7f810`. | Native install/bundle/platform build cost if retained. | Regenerate/prune the lock with the current manifest; do not hand-edit transitive entries. |
| `eslint@9.39.5` | Deprecated direct dev version | Lockfile explicitly marks this version unsupported. | Reduced future compatibility/security support. | Plan an isolated ESLint 10 migration; do not combine with unrelated cleanup. |
| `@types/node@20.19.43` | Review | Runtime observed on Node 24; no `engines`, `.nvmrc`, or version manager file. | Type/runtime mismatch. | Choose and document a supported Node version, then align types. |
| `framer-motion@13.4.1` | Active; patch available | Used broadly; `pnpm outdated` reports 13.4.2. | Low. | Review changelog and update separately if desired. |
| `lucide-react@1.47.0` | Active; patch available | Used broadly; `pnpm outdated` reports 1.48.0. | Low. | Isolate update and run build/lint. |
| `@radix-ui/react-icons` in `next.config.ts` | Stale config token | Not declared, locked, installed, or imported. | Misleading optimization configuration. | Remove the entry; do not add a package solely for it. |

`pnpm audit --json` reported zero known critical/high/moderate/low advisories at audit time. That is evidence about the current advisory database, not a guarantee against future or undisclosed supply-chain issues.

## Broken Imports / References

### Import integrity

- No unresolved local static imports were found by the repository import graph.
- `pnpm exec tsc --noEmit` and the production build both pass, which is strong evidence that current TypeScript/module paths resolve.
- Dynamic imports used by chart and page-transition components are valid and appear in the build.

### Broken or stale references

1. `platformCredentialsConfigured` is described as an active UI guard in `src/app/docs/developer/page.tsx:234-237`, but has no runtime caller. Actual status checks are DB-only and do not mirror env fallback.
2. `refreshTokenEnc` is written by the OAuth callback but never read; this is a write-only lifecycle gap, not safe-to-delete evidence.
3. `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` is required by the webhook route but absent from `.env.example`, README, deployment docs, and both Instagram guides.
4. `ROADMAP.md` still describes SQLite/mock/future work that current source contradicts.
5. `next.config.ts` references an undeclared `@radix-ui/react-icons` optimization target.
6. `docs/INSTAGRAM_QUICKSTART.md` says a Facebook Page is not required, while `src/app/docs/connecting-accounts/page.tsx` says the account must be linked to one.
7. `src/app/docs/developer/page.tsx` says the same `AUTH_SECRET` should be shared across environments, while `docs/DEPLOYMENT.md` says it is safe for it to differ. This is a documentation contradiction, not evidence that the current cookie implementation is broken.

No broken import should be inferred from the absence of a static import for route handlers, `proxy.ts`, `template.tsx`, migrations, or external callbacks; those are framework/configuration/runtime references and were checked separately.

## Duplicate Code

| Location A | Location B | Overlap | Authoritative implementation | Recommended action |
|---|---|---|---|---|
| `src/lib/mock-data.ts` | `src/app/actions/dashboard.ts` / real pages | Mock stats/activity/accounts versus live database data. | Live actions. | Remove mock module after external check. |
| `src/components/motion/animated-counter.tsx` | `src/components/motion/number-ticker.tsx` | Two animated number primitives. | `NumberTicker` is actively used. | Remove the unused counter or consolidate deliberately. |
| `src/app/actions/credentials.ts` | `src/app/actions/platform.ts` | Generic credential upsert/display versus platform-specific credential upsert. | Specialized platform actions. | Remove generic CRUD; keep `getCredentialValue` as an internal DAL helper. |
| `src/app/actions/publish.ts:34-102` | `src/app/actions/publish.ts:112-159` | Old FormData actions versus positional Composer actions. | `publishToAllNowAction` is live. | Remove old action block. |
| `src/app/actions/posts.ts:106-136` | `src/lib/scheduled-posts.ts:84-107` | Two terminal-state writers implement the same published/failed rule. | Shared server-side transition helper should be canonical. | Extract one transition function; do not remove either caller blindly. |
| `src/app/actions/dashboard.ts:50-60` | `src/app/actions/inbox.ts:34-45`; Assistant client `:59-67` | Three relative-time formatters with slightly different behavior. | One shared formatter. | Consolidate after UX decision on units/locales. |
| `src/lib/ai.ts:152-158` | `src/app/actions/analytics.ts:74-80` | Registry display-name fallback duplicated. | One platform display helper. | Centralize. |
| Brand color maps in `platform-icon.tsx` and `analytics.ts` | Same platform IDs | Colors can drift (for example icon and chart palettes differ). | Registry/theme tokens. | Move colors to one platform metadata source. |

The duplicated secret-key logic in `src/lib/session.ts` and `src/proxy.ts` is intentional across the framework boundary and should not be removed casually. The duplicated weekly chart renderers are also intentional because Dashboard and Analytics have different visualizations.

## Legacy / Obsolete Code

### Clearly legacy or scaffold residue

- `src/lib/mock-data.ts` and three motion files are initial-release artifacts with no current consumers.
- All five `public/*.svg` files are generic Next/Vercel starter assets; the application uses inline platform SVGs instead.
- `data/hilbras.db*` are pre-PostgreSQL local artifacts. They are ignored, not part of the shipped source, but may contain sensitive local data.
- `ROADMAP.md` is stale documentation, not a safe deletion target. Rewrite/archive it with an owner decision.
- The two Instagram setup documents overlap substantially. Both are referenced; consolidate rather than deleting one blindly.

### Compatibility/partial code that must not be called dead

- `src/proxy.ts` is the intentional Next 16 replacement for `middleware.ts`.
- `refreshTokenEnc` is a write-only but potentially future-required OAuth field; audit stored data and provider requirements before removing it.
- The Instagram webhook is externally registered and intentionally acknowledges events for now; it is not dead merely because it has no internal importer.
- The public media route is intentionally called by Meta using a capability URL; its lack of an internal import is expected.
- `drizzle/meta` and all SQL migrations are history, not dead files.

## Commented-Out Code

No large executable commented-out code blocks were found. Comments are predominantly explanatory documentation. The one ESLint suppression in Composer is localized to arbitrary external image preview and should be retained only with the same allowlist/size rationale. No genuine `TODO`, `FIXME`, `HACK`, `XXX`, `BUG`, `TEMPORARY`, or `WORKAROUND` markers were found. Incomplete work is instead expressed in roadmap prose and “not yet supported” branches, which this report classifies as technical debt rather than dead comments.

## TODO / FIXME / HACK Audit

A repository-wide case-insensitive search was performed for `TODO`, `FIXME`, `HACK`, `XXX`, `BUG`, `TEMP`, `TEMPORARY`, `WORKAROUND`, `DEPRECATED`, `REMOVE`, and `REVISIT`.

| Marker class | Result | Classification/action |
|---|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` | No genuine source or documentation markers found | No dead placeholder comment to remove |
| `BUG` / `TEMP` / `TEMPORARY` / `WORKAROUND` | No genuine markers found | Incomplete work is represented by prose and runtime branches, not comments |
| `DEPRECATED` / `REMOVE` / `REVISIT` | No actionable code markers found | Review documentation separately; do not infer deletion from absence |
| Commented-out executable code | None found | No large commented implementation block identified |
| ESLint suppression | One localized Composer image-preview suppression | Retain only with the arbitrary-URL/size rationale; it is not a blanket suppression |

The roadmap’s unchecked items and `Publishing not yet supported` branches are technical debt/product gaps, not TODO comments. They are tracked in this report rather than left as hidden implementation notes.

## Security Findings

| Finding | Severity | Evidence | Impact / remediation |
|---|---|---|---|
| Local secrets in `.env.local` | P1 | Populated ignored env file; no tracked secret match. | Rotate if shared; use secret manager. |
| Decrypted client secrets to browser | P1 | `getPlatformCredentials` is a live action and Accounts stores the value. | Return masked/presence only. |
| SSRF via redirects/rebinding | P1 | Guard checks initial URL; fetch follows redirects. | Egress filtering/manual redirects/pinned addresses. |
| Shared AI spend abuse | P1 | Open signup; only Assistant route limited; limiter fails open. | Global quotas, verification, caps, circuit breaker. |
| Cron GET CSRF | P1 | Session fallback on state-changing GET; Lax cookie. | POST + Origin/CSRF/idempotency. |
| Client-controlled post URLs/status | P1 | Live action accepts result URL/success; Analytics renders href. | Server-authoritative state and URL allowlist. |
| Public media capability storage | P2 | Unauthenticated immutable bytes, no quota/cleanup. | Explicit public storage policy, quotas, retention. |
| No database RLS | P2 | Migrations/snapshots show `isRLSEnabled: false`; app filters by user. | Add RLS or document app-only isolation and test every query. |
| CSP `unsafe-inline` | P2 | `next.config.ts` explicitly allows inline script/style. | Nonce/hash-based CSP; lower priority than fixing credential exposure. |
| Token-bearing query strings / unbounded webhook work | P2 | Graph/Instagram calls put tokens in URLs; webhook bodies have no cap; Threads callbacks decrypt every stored secret per request. | Minimize URL secrets, cap/rate-limit bodies, index/app-map webhook secrets, and use bounded verification work. |
| Account lockout abuse | P2 | Detailed lockout response and non-atomic counters. | Generic errors, durable atomic rate limits, IP controls. |

No raw HTML injection, shell execution, or obvious SQL injection was found. Most user/platform text is rendered through React escaping, but URL-valued output needs an explicit protocol/host allowlist.

## Error Handling Findings

- `getInboxMessages` catches provider/network failures and returns `[]`; users cannot distinguish “no messages” from an expired token, permission error, rate limit, or provider outage (`src/app/actions/inbox.ts:47-107`).
- Assistant summarization/memory failures are deliberately swallowed (`:146-149,208-214`), which protects the chat but needs metrics and user-visible stale-context behavior.
- `getSessionUser` catches every error as `null` (`src/lib/session.ts:114-116`), so database outages can appear as an auth redirect rather than an operational failure.
- OAuth callback/profile/token fetches do not consistently catch and classify network errors (`callback:105-131,179-246`); users can receive a generic 500 instead of a recoverable connection error.
- `recordPublishOutcome` silently returns on invalid input and has no idempotency/audit result (`posts:124-136`).
- Cron, Threads callback, and several mutation actions allow uncaught database errors to escape.
- External HTTP calls generally have no timeout, so a slow provider can hold a serverless invocation open.
- Error messages from AI providers are returned to users after basic sanitization; keep diagnostics in structured logs and avoid returning raw upstream bodies in production.

## Async / Concurrency Findings

1. `Promise.all` publish failure propagation can produce late side effects and incorrect terminal state (AUD-013).
2. Scheduler claim/reclaim has no lease token or conditional finalize; crash recovery is at-least-once and can duplicate posts (AUD-007).
3. Token refresh can run concurrently from `getConnectedAccount` and `refreshExpiringTokens`; no row lock/compare-and-swap protects refresh/write ordering.
4. AI default selection performs “unset all” and “set one” as separate writes; concurrent selection can leave zero or multiple defaults.
5. OAuth reconnect and Telegram reconnect delete then insert without a transaction; a failed insert can remove the previous working connection.
6. `recordMemories` deduplicates and evicts with separate reads/writes; concurrent extraction can exceed the cap or insert duplicates.
7. New Assistant sessions can race on the client-minted primary key; one request can fail on the unique constraint.
8. Client async effects lack cancellation/generation guards; late inbox suggestions, session refreshes, and preference updates can overwrite newer state.
9. AI streams do not cancel upstream work when the browser disconnects, allowing avoidable provider spend and resource use.
10. No graceful shutdown/pool lifecycle policy is documented for the module-global `pg.Pool`; serverless platforms usually reclaim it, but self-hosting behavior should be explicit.

## Test Suite Findings

### Current state

- **Total tests: 0.**
- No test script, runner, test directory, coverage configuration, or CI workflow.
- No tests are obsolete or misleading because no test suite exists; the problem is total absence.
- The successful build and typecheck prove compilation only, not runtime correctness.

### Critical missing tests

1. **Auth/session:** signup validation and uniqueness races; bcrypt cost; lockout atomicity; cookie flags; proxy refresh; token-version revocation; deleted-user handling.
2. **Crypto:** encrypt/decrypt round trip, wrong key, malformed payload, tamper detection, key rotation behavior.
3. **OAuth:** state/PKCE binding, platform-specific GET/POST/Basic modes, token response variants, profile failure, reconnect transaction, tenant scoping.
4. **Publishing:** one success plus one rejection, all failures, duplicate/reclaim race, per-platform timeout, token expiry, media type/account selection, idempotency.
5. **AI/security:** SSRF literals/DNS/redirects/rebinding, rate-limit atomicity/fail behavior, input/output caps, stream fragmentation/final buffer/disconnect, provider-format matrix.
6. **Data isolation:** every action/API query with two users; media ownership policy; callback owner scoping; client-supplied post outcomes.
7. **Media/webhooks:** magic-byte mismatch, size/body limits, quota, HMAC timing/signature, missing env, replay/tenant behavior.
8. **UI regressions:** schedule mode with empty date, provider edit without API key, preference failure reconciliation, scheduler timezone boundaries, analytics partial results.
9. **Migration/tooling:** fresh Postgres apply, migration check, seed/rollback policy, lint/typecheck/build/audit gates.

## Build / Tooling Findings

- Production build and TypeScript pass, but `pnpm lint` fails. Representative errors include explicit `any`, React effect/purity violations, an empty interface extending a built-in type, and unescaped JSX text.
- There is no `typecheck` script even though direct `tsc` passes; CI should expose a stable command.
- There is no `test` script and no CI quality gate.
- `vercel.json` declares only a daily cron and no route `maxDuration`; scheduler timeout behavior is not encoded in deployment configuration.
- `drizzle.config.ts` uses a non-null assertion for `DATABASE_URL` and does not itself load `.env.local`. Drizzle Kit’s bundled dotenv defaults to `.env`; verify the documented `cp .env.example .env.local && npx drizzle-kit push` path or make the env file/command explicit.
- `next.config.ts:54` names an undeclared package in `optimizePackageImports`.
- No Node `engines`, `.nvmrc`, `.node-version`, or `.tool-versions` exists.
- `.gitignore` correctly excludes `.next`, node_modules, TypeScript build info, env files, local DB files, `.zcode`, and `.freebuff`; no generated build output is tracked.

## Documentation Inconsistencies

| Topic | Current documentation | Actual implementation | Required correction |
|---|---|---|---|
| Database | `ROADMAP.md` says SQLite | `pg`/PostgreSQL and Postgres migrations | Rewrite roadmap. |
| Feature status | Roadmap calls OAuth/AI/posts/analytics future/mock work | Several are implemented, with different scope | Replace status table with verified capability matrix. |
| Platforms | README/docs claim ten publishers | Five dispatcher cases | Separate OAuth connection support from publishing support. |
| Analytics | README/landing/privacy imply engagement metrics | Dashboard/analytics intentionally omit them | State current metrics accurately. |
| Instagram setup | Quickstart says no Facebook Page; connecting page says Page required | Registry says professional account; external API requirement is not consistently documented | Choose one canonical guide and test against current Meta setup. |
| Built-in AI | Docs say guaranteed/out-of-box fallback | Empty keys make it unavailable | Say “configured by server operator” and show setup state. |
| AI providers | Docs say endpoint/model never shown | Built-in base URL is returned to Settings; custom model IDs are shown by design | Clarify exactly which fields are hidden. |
| Composer | Docs say failed posts remain editable | Queue exposes delete only; no edit/retry action | Implement edit/retry or correct docs. |
| Developer stack | README/developer docs list Zustand | No Zustand import/store | Remove claim or implement state layer. |
| Webhook setup | Route requires `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Token absent from all setup docs/templates; POST verification uses only deployment `INSTAGRAM_CLIENT_SECRET`, while Accounts supports per-user app credentials | Add token/credential model to env template and deployment checklist. |
| Privacy | Promises account deletion, RLS, engagement data, direct browser forwarding of AI keys | No account deletion/RLS/engagement implementation; server decrypts and sends provider requests | Rewrite policy only after implementation decision. |
| Assistant transport | Developer docs call `/api/assistant` SSE | Route returns `text/plain` chunked stream | Call it a streamed response or implement SSE. |

Local Markdown links currently resolve, but link validity does not prove the linked instructions match runtime behavior.

## Performance Findings

1. The generated build diagnostics report approximately 708–792 KB uncompressed first-load JavaScript for landing/dashboard/accounts/settings/composer/assistant/inbox/analytics routes. This is a measurement, not a universal performance failure, but it is a credible optimization target.
2. The landing page, Accounts, Composer, Settings, and Assistant are large client components with many motion imports. Dynamic chart imports help, but much of the page shell remains client-heavy.
3. `getAnalyticsData` loads all published posts for a user with no pagination or date bound. `listPosts` caps at 50, while the docs describe a complete queue.
4. Inbox performs sequential external API calls per account and has no timeout/cache. One slow provider delays all messages.
5. Accounts calls `checkCredentialsExist` once per platform, each doing separate DB lookups; Next client dispatch is sequential for server actions, so this creates a request waterfall.
6. Dashboard/Analytics pages invoke multiple server actions that each repeat `getSessionUser` and issue independent queries.
7. `posts`, `social_accounts`, and several common status/date predicates have no supporting indexes beyond the primary keys and chat/memory indexes. Confirm with `EXPLAIN` before adding indexes.
8. The module-global `pg.Pool` has no explicit max, connection timeout, or idle policy. Serverless connection multiplication needs deployment-specific sizing/pooler review.
9. Media bytes are stored in PostgreSQL, increasing database backup/replication size; no retention or quota bounds growth.
10. The app has no RUM, server timing, query-plan, or external-call latency instrumentation, so these are risk indicators rather than measured production bottlenecks.

## Architecture Findings

- **Layer inversion:** `src/lib/ai.ts` imports `src/app/actions/dashboard.ts` to build context. Move data access into a server-only DAL and have both AI and UI layers depend on it.
- **God service:** `src/lib/publish.ts` is 907 lines and mixes token lookup/refresh, Telegram, Instagram, Facebook, X, Threads, media polling, and orchestration. Split connector implementations behind a typed common interface and shared HTTP policy.
- **Large client pages:** Accounts (820 lines), Composer (607), Settings client (543), Assistant (448), and Inbox (324) combine too many responsibilities. Split data hooks, forms, result panels, and dialogs without changing behavior first.
- **Capability model missing:** Registry metadata describes content rules but not actual publisher implementation/status. Add explicit states rather than allowing every connected account into every target selector.
- **Credential boundary mixed:** A `"use server"` action file contains an internal decrypted getter and dead generic CRUD. Separate internal server-only DAL functions from client-facing actions.
- **No centralized invariants:** Post terminal state, provider defaults, token refresh, and connection replacement are implemented in multiple places or via string conventions.
- **Framework boundary duplication is intentional:** Proxy/session secret logic is duplicated because Proxy and server components run in different layers. Keep the behavior aligned through tests rather than deleting one blindly.
- **No observability boundary:** External API calls, scheduler claims, AI spend, and webhook decisions have no structured event schema or metrics.

## Files Recommended for Removal

### Safe to remove after the stated checks

1. `src/lib/mock-data.ts`
2. `src/components/motion/animated-counter.tsx`
3. `src/components/motion/perspective-card.tsx`
4. `src/components/motion/sparkles.tsx`

These are safe within the current private repository after an external-consumer check. They are not needed by App Router conventions, dynamic imports, build config, tests, or runtime registration.

### Likely safe, but verify external URLs first

- `public/file.svg`
- `public/next.svg`
- `public/vercel.svg`
- `public/window.svg`
- `public/globe.svg`

These are generic starter assets with no internal references, but public URLs can be externally hot-linked. Check production/CDN logs and documentation before deleting.

### Do not remove automatically

- `src/proxy.ts`
- `src/app/docs/template.tsx`
- all `drizzle/*.sql` migrations and `drizzle/meta/*`
- API route handlers used by external providers
- `refreshTokenEnc` schema column
- local `.env.local` before secret rotation/backup
- SQLite files before backup/manual verification

## Files Requiring Manual Verification

1. Live OAuth behavior for X, Reddit, LinkedIn, TikTok, YouTube, Pinterest, and current Meta token rules; no external calls were made.
2. Whether any private/demo branch or external script imports the dead source modules.
3. Whether public SVG URLs are used by external sites.
4. Whether local SQLite files contain data needed for recovery.
5. Whether `.env.local` has been copied to shared logs/backups and which secrets must be rotated.
6. The actual Vercel plan/function timeout and database connection ceiling.
7. The intended privacy/legal scope for marketing claims, testimonials, GDPR language, and account deletion.
8. The intended timezone for scheduled publishing and analytics.
9. Whether environment-only platform credentials are a supported deployment mode; the docs say yes, the UI says no.
10. Whether preferences/plans/teams are roadmap features or intended current product behavior.

## Files That Should Be Refactored

| File/module | Reason | Smallest sensible refactor |
|---|---|---|
| `src/lib/publish.ts` | Multi-platform god service and duplicated error/token code. | Extract per-platform connector modules, shared timeout/HTTP helper, typed capability map, and idempotent result model. |
| `src/app/(dashboard)/accounts/page.tsx` | 820-line client page, secret loading, OAuth state, dialogs, and health UI. | Extract connection card/modal/credential form and a server-provided status DTO; never send raw secrets. |
| `src/app/(dashboard)/composer/page.tsx` | Scheduling, AI, uploads, publishing, queue, and optimistic state in one component. | Extract editor/platform selector/queue/publish hook; centralize schedule validation. |
| `src/app/(dashboard)/settings/settings-client.tsx` | Provider CRUD, profile/password, preferences, and memory in one client component. | Split settings sections and use server-confirmed state after mutations. |
| `src/lib/ai.ts` + `src/app/actions/dashboard.ts` | Layer inversion and duplicated provider/context resolution. | Introduce a server-only DAL/provider service; remove UI action imports from lib. |
| `src/lib/scheduled-posts.ts` | Lease, retry, timeout, and terminal-state invariants are implicit. | Extract claim/lease/finalize service with transaction and elapsed-time budget. |
| `src/db/schema.ts` + migrations | Free-form statuses/platforms/defaults and missing constraints/indexes. | Add additive migration for constraints/indexes; consider RLS and timezone-aware timestamps. |
| `src/app/actions/*.ts` | Auth/data logic and return DTOs are mixed with UI action contracts. | Move mutations/queries to `src/server`/`src/data` DAL; keep actions thin and DTO-minimal. |
| `src/app/globals.css` + UI primitives | Missing semantic token mappings and unused blocks coexist. | Define/verify all design tokens, remove dead CSS, and add visual regression checks. |

## Dependency Cleanup

1. Remove the 14 confirmed unused direct packages listed above, beginning with `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, and `zustand`.
2. Regenerate `pnpm-lock.yaml` from the cleaned manifest and run a frozen install; do not restore a package merely to satisfy a stale lockfile.
3. Prune optional SQLite peer artifacts through a lockfile regeneration, not manual YAML edits.
4. Remove the undeclared `@radix-ui/react-icons` optimization entry.
5. Review ESLint 9 deprecation and Node type/runtime alignment as separate changes.
6. Review Framer Motion/Lucide patch updates independently; do not mix dependency upgrades with behavior changes.
7. Keep `pnpm audit` and frozen-lock checks in CI. The current audit result is clean, but future advisories and supply-chain changes still require review.

## Test Improvements

### Phase 1: safety regression tests

- Composer schedule-mode state transition and save-failure behavior.
- `recordPublishOutcome` authorization/idempotency and URL allowlist.
- Cron route method/CSRF behavior.
- AI quota accounting and limiter failure policy.
- Redirect/DNS SSRF tests.
- OAuth state/PKCE and provider protocol matrix.
- Scheduler claim, crash reclaim, timeout, and duplicate prevention.

### Phase 2: integration tests

- PostgreSQL migrations and tenant isolation with two users.
- Credential encryption, key mismatch, reconnect transaction, and token refresh.
- All publisher connectors against mocked provider responses, including partial failure and media types.
- Media upload limits and public retrieval policy.
- Meta/Instagram webhook signatures, missing secrets, replay behavior, and owner scoping.
- Analytics calculation from mixed success/failure result arrays.

### Phase 3: browser tests

- Signup/login/session revocation.
- Accounts configure → OAuth connect → health warning → reconnect.
- Composer generate → media upload → schedule with missing/invalid date → publish.
- Assistant streaming, disconnect, rate limit, and memory deletion.
- Inbox provider failure and reply behavior.
- Timezone boundary around Monday/Sunday scheduler grid.

### Quality gates

- `pnpm lint`
- explicit `pnpm typecheck`
- unit/integration tests
- `pnpm build`
- `pnpm audit --json`
- frozen-lockfile install
- migration check

## Final Cleanup Classification

### KEEP

- Next App Router pages/layouts/templates, all registered API routes, `src/proxy.ts`, active UI primitives, `src/lib/session.ts`, `src/lib/crypto.ts`, Drizzle schema/migrations, `vercel.json`, security headers, and current docs as source material.

### KEEP + REFACTOR

- `src/lib/publish.ts`, `src/lib/ai.ts`, `src/lib/scheduled-posts.ts`, `src/db/schema.ts`, `src/app/actions/*.ts`, Accounts, Composer, Settings, Assistant, Inbox, and Analytics pages. They are active but combine too many invariants and responsibilities.

### FIX

- AUD-001 through AUD-033, especially schedule handling, platform capabilities, AI spend/SSRF, credential exposure, deletion, scheduler idempotency, OAuth modes, analytics, inbox, lint, and tests.

### INVESTIGATE

- Live OAuth/provider behavior, APP_URL/forwarded-header trust, exact Vercel timeout/connection limits, external use of public SVGs, local SQLite contents, privacy/legal claims, timezone intent, and the OAuth state transaction model.

### DEPRECATE

- Generic credential CRUD, old FormData publish actions, `generatePostAction`, the mock-data path, hard-coded “AI optimal times,” and roadmap/documentation claims that describe superseded architecture. Remove only after replacement/migration decisions.

### REMOVE

- Four high-confidence unused source modules, five likely-unused starter SVGs after URL checks, confirmed unused direct dependencies, and exact unused imports/constants/CSS.

### UNKNOWN

- Private/demo consumers outside this repository, external hot-links, deployment-specific provider/host behavior, local data recovery needs, and whether plan/team/privacy promises are intentional roadmap items.

## Prioritized Remediation Plan

### Phase 1 — Critical / stop-ship

1. Rotate and inventory local secrets; remove unused local provider keys.
2. Fix Composer schedule validation and save-result handling (AUD-001).
3. Reconcile platform capability UI/docs with the five implemented publishers; disable unsupported targets (AUD-002).
4. Add global AI quotas/caps and protect built-in-key signup (AUD-003).
5. Fix SSRF redirect handling and production egress policy (AUD-004).
6. Stop returning decrypted platform secrets to the browser (AUD-006).
7. Make cron manual triggering CSRF-safe and non-GET (AUD-010).
8. Define/implement account deletion and correct privacy claims (AUD-005).
9. Add server-authoritative post finalization and URL validation (AUD-009).
10. Add a minimal test/CI gate before further feature work (AUD-012).

### Phase 2 — High priority correctness and reliability

1. Implement/test OAuth provider modes and refresh-token lifecycle (AUD-008).
2. Redesign scheduler claims, timeouts, and idempotency (AUD-007).
3. Replace publish `Promise.all` with settled per-platform outcomes (AUD-013).
4. Add transaction/constraint/index work for connections, defaults, posts, and timestamps (AUD-021, AUD-030).
5. Add shared outbound HTTP timeout/cancellation and stream parser tests (AUD-017).
6. Correct analytics, inbox, environment-aware credential status, and provider edit behavior (AUD-015, AUD-016, AUD-019).
7. Fix lint errors and make the quality gate blocking (AUD-026).

### Phase 3 — Cleanup and truthful product surface

1. Remove dead source files, dead actions, unused exports/imports/CSS, and unused direct dependencies.
2. Consolidate Instagram setup docs and rewrite `ROADMAP.md`/README claims.
3. Remove or implement inert preferences, hard-coded optimal-time data, export/search/notification controls, and webhook event processing.
4. Add the missing webhook env var and Drizzle/Node setup scripts.
5. Review public media retention/quotas and stale local SQLite artifacts.

### Phase 4 — Maintainability and performance

1. Introduce a server-only DAL and typed DTOs.
2. Split the god publisher and large client pages.
3. Add pagination, query-plan-driven indexes, provider call caching/coalescing, and pool policy.
4. Reduce client bundle/motion work and measure Core Web Vitals/RUM.
5. Add structured observability, accessibility coverage, and reduced-motion behavior.
6. Add plan/entitlement/team/billing infrastructure only if those product promises are intentional.

## Risk Assessment

| Risk | Assessment | Reason |
|---|---|---|
| Accidental/live publishing | **High** | Empty-date schedule fallthrough, partial outcomes, and crash requeue can publish or duplicate content. |
| Credential exposure | **High** | Browser receives client secrets; local env contains live secrets. |
| AI cost abuse | **High** | Shared built-in key and incomplete rate limits. |
| SSRF/internal network access | **High** | User-controlled provider URLs follow redirects after initial validation. |
| Data/privacy compliance | **High** | Deletion/export promises are not implemented. |
| Tenant isolation | **Medium** | App filters are generally present, but no RLS and some write races/duplicates remain. |
| External-provider correctness | **High uncertainty** | Several registry modes and publishers are incomplete; live APIs were not called. |
| Regression confidence | **Very high risk** | No tests/CI and lint is red. |
| Cleanup deletion risk | **Low for source files, medium for public/local artifacts** | References/history are strong for source candidates; external URLs/local data need manual checks. |

## Second Verification Pass

Before finalizing, every P1/P2 issue was re-read against the current source rather than accepted from the first-pass wording.

- **Schedule path:** re-read `composer/page.tsx:190-218`; no alternate date guard or save-result check exists. AUD-001 remains confirmed.
- **Platform matrix:** searched all imports, dynamic imports, `publishForUser` cases, route/config references, and generated route output; only five dispatcher cases exist. AUD-002 remains confirmed.
- **AI spend:** searched every model-call entry point and all `consumeRateLimit` call sites; only the Assistant route is limited. AUD-003 remains confirmed.
- **SSRF:** re-read `net-guard.ts` and `ai-sdk.ts`; default redirect following and the DNS TOCTOU gap remain. A suspected IPv4-mapped-IPv6 bypass was tested against the actual `isBlockedAddress` logic and **discarded** because unparsable leading IPv6 heads fail closed. The redirect/rebinding finding remains valid.
- **Secrets/deletion:** verified the generated Server Action manifest, all user-data tables, callback delete predicates, and absence of account deletion/export routes. AUD-005, AUD-006, and AUD-009 remain.
- **Scheduler/concurrency:** re-read claim, reclaim, finalize, token refresh, provider default, reconnect, and memory writes. No lease owner, transaction, atomic counter, or compare-and-swap was found; AUD-007, AUD-013, AUD-021, and AUD-028 remain supported.
- **OAuth:** re-read registry fields and callback branches. `tokenAuth`/`usesPkce` have no consumers, `refreshTokenEnc` is write-only, and `APP_URL` fallback is not enforced. The unsigned-state concern remains explicitly **potential**, not a claimed takeover.
- **Dead-code decisions:** re-ran source/module-path searches, dynamic-import checks, framework-convention checks, generated Server Action manifests, and Git path history. `proxy.ts`, `template.tsx`, migrations, external callback routes, and public media retrieval were excluded from deletion. Public assets and SQLite artifacts remain manual checks.
- **Imports/tooling:** reran TypeScript/build/Drizzle checks; unresolved local imports were not found. Lint remains red, and no test/CI gate exists.

The only findings intentionally left uncertain are those dependent on live providers, deployment proxy behavior, database concurrency, traffic scale, or legal/product intent. They are labeled `POTENTIAL`, `INVESTIGATE`, or `MANUAL VERIFICATION` rather than presented as confirmed defects.

## Final Repository Health Assessment

**Overall status: AMBER/RED — retain for development, do not treat as production-ready.**

- **Compilation:** Green. The current revision builds and type-checks.
- **Core architecture:** Partially sound. The main flows are real and understandable, but capability and data-access boundaries are incomplete.
- **Security:** Red until secret exposure, SSRF, AI spend, cron CSRF, unsafe URLs, and deletion semantics are addressed.
- **Functional completeness:** Red for the advertised ten-platform/analytics/inbox/plan surface; amber for the five implemented publishers and Assistant.
- **Quality engineering:** Red because there are no tests/CI and lint fails.
- **Maintainability:** Amber/red. The code is reasonably documented in places, but large modules, duplicated invariants, stale docs, and dead dependencies obscure the authoritative path.
- **Cleanup readiness:** Good for the four high-confidence source modules and dead action surfaces after external-consumer checks; manual for public assets and local data.

### Concise audit totals

- **Total files inspected:** 151 tracked files, plus ignored local/generated artifacts and installed dependency metadata.
- **Total source files:** 113 under `src/` (111 TypeScript/TSX plus CSS/favicon).
- **Total tests:** 0.
- **Confirmed bugs:** 18 code/documentation defects listed in the confirmed-bug table.
- **Potential bugs/risks:** 11 grouped runtime/scale/security risks in the potential-bug table.
- **Security findings:** 11 distinct security/privacy issues.
- **Dead files:** 9 tracked internal/scaffold candidates; 3 additional local SQLite artifacts require manual verification.
- **Dead modules:** 4 high-confidence source modules.
- **Unused exports:** 20 high-confidence runtime/action symbols (13 library/component symbols plus 7 dead action exports), plus additional type-only/design-system surface.
- **Unused dependencies:** 14 direct dependencies, plus 2 stale optional SQLite peer artifacts and 1 stale config token.
- **Duplicate implementations:** 7 logical families; session/Proxy key duplication and chart variants are intentional exceptions.
- **Legacy components:** 4 source modules, 1 stale roadmap, and 1 local pre-Postgres database family.
- **Critical findings:** 0 P0.
- **High findings:** 13 P1.
- **Medium findings:** 20 P2.
- **Low findings:** 6 P3 plus 1 P4 informational cleanup/audit result.
- **Files safe to remove:** 4 high-confidence source files (plus 5 public assets that are likely safe after external-URL verification).
- **Files requiring manual verification:** 10 categories/files, including OAuth behavior, local secrets, public asset URLs, SQLite contents, deployment limits, privacy scope, and timezone/product intent.
