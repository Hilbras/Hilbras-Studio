# Development

How to work on Hilbras Studio: the commands, the invariants a change must not
break, and the checks that are enforced rather than remembered.

If you are here to *release*, see [`releasing.md`](releasing.md). If you are here
to understand why the code is shaped the way it is, see
[`architecture.md`](architecture.md).

---

## 1. Setup

```bash
pnpm install
cp .env.example .env.local   # database URL, and a key pair — see §6
npx drizzle-kit push        # apply the schema
pnpm dev
```

Requires Node 22+ and Postgres 16. Integration tests start their **own**
Postgres container, so a local database is only needed for `pnpm dev`.

### The commands

| Command | What it does | When |
|---|---|---|
| `pnpm dev` | Next dev server | |
| `pnpm build` | Production build | Before pushing |
| `pnpm lint` | ESLint | Before pushing |
| `pnpm typecheck` | `tsc --noEmit` | Before pushing |
| `pnpm test` | Unit tests (`src/**/*.test.ts`) | Before pushing |
| `pnpm test:integration` | Integration tests (Testcontainers) | Before pushing |
| `pnpm test:integration <path>` | One integration file | While iterating |
| `pnpm release:check` | The pre-tag gate | Only when releasing |

`pnpm test:integration` starts one `postgres:16-alpine` container **per test
file** and runs the real migrations, so it takes 40–80 seconds for the full
suite. Pass the path directly — `pnpm test:integration tests/integration/foo.test.ts`.
The `--` form (`pnpm test:integration -- <path>`) is silently ignored by the
script and will run everything.

Integration tests are **transpiled, not typechecked**. A test can therefore
reference a helper it never imported and fail at runtime with a
`ReferenceError` rather than a type error. See §5.

---

## 2. The invariants

These are the rules the codebase is built around. A change that violates one is
a defect even if it passes every check, because the checks do not all cover
these.

### Execution state is server-authoritative (ADR-003)

A transition is computed from the current state and an event, and applied in
`runtime/service.ts` alongside the event it records — so the history can never
disagree with the state. There is no client-side state machine. `runtime/state.ts`
holds the transition table and nothing else; it is pure, which is why it has the
densest unit tests in the repo.

**Never** write `runs.state` or `run_steps.state` from anywhere else.

### A claim is a lease, not a flag (v0.9.5)

`claimStep` is a compare-and-swap from the state the caller *read*, and the queue
is at-least-once. So a step observed as `running` can be "claimed" from
`running` to `running`, and a redelivery would execute the same step twice in
parallel. `claimStep` therefore refuses a `running` step until its claim is older
than `STEP_CLAIM_LEASE_MS` (5 minutes), which is also what recovers a step whose
worker was killed outright. `releaseStepClaim` covers the crash a `catch` can
reach; the lease covers the one it cannot.

### Reads are scoped in the query, not by the caller (ADR-008)

`runtime/queries.ts` is the only module UI code may read user data through, and
every function there puts `userId` in the `WHERE` clause. `getRun`,
`listRunSteps` and `listRunEvents` in `runtime/service.ts` stay deliberately
unscoped — they are used by the executor, which has already established
ownership — and they are unreachable from pages.

The same rule now applies to `lib/chat.ts`: `loadMessages`, `appendMessage`,
`saveSummary` and `touchSession` all take a `userId` and scope in their own
`WHERE` clause. Session ids are minted client-side, so they are attacker-supplied.

### A tool's capability is not a permission (Phase 6)

A capability says what a tool *can* do. A policy says whether it may, unattended.
`ToolSpec.sideEffect` is the discriminator: an approvable side effect requires a
decision, `deny` fails without asking, and everything else runs. The two are
separate settings on purpose — see [`runtime/permissions.md`](runtime/permissions.md)
and [`runtime/policies.md`](runtime/policies.md).

### A vocabulary is one place, `Record`-keyed

`runtime/view.ts` maps state to label, tone and meaning as
`Record<ExecutionState | ApprovalState | GoalStatus, StatusMeta>`. Adding a state
is a compile error rather than a blank badge, and `approvalDeadlineView` calls
`isOverdue` so the screen and the server cannot disagree about a deadline. The
clock is a parameter, never `Date.now()` read inside.

Follow that pattern. A `Partial<Record<…>>` or a `Record<string, …>` gives up the
only property that makes it worth having.

---

## 3. What is enforced, and how

### `pnpm release:check` — nine checks before a tag exists

Fails if the version in `package.json` and `docs/architecture.md` disagree, the
changelog entry is missing or undated, `[Unreleased]` still holds work, the tree
is dirty, the tag already exists, `HEAD` is already pushed, or a `.env`/`.db`
file is tracked. See [`releasing.md`](releasing.md).

### Drift guards — tests that fail when two things disagree

Three lists in this codebase must agree with something else, and a list that must
be edited in two places will be edited in one place. Each has a test:

| What | Guard | Why it cannot be derived |
|---|---|---|
| `PROTECTED` routes ↔ `config.matcher` | `src/proxy.test.ts` | Next.js statically parses `matcher` and rejects anything that is not a literal string array. Tried; the build fails. |
| Outbound `fetch(` calls | `src/lib/http.test.ts` | Nothing forces a 20-site mechanical change to be applied everywhere. |
| `getSecretKey` | one module, [``lib/secret-key.ts`](../src/lib/secret-key.ts)`] | It was written out twice — in `proxy.ts` and `lib/session.ts` — and a fix to one did not reach the other. |

The third is the lesson behind the first two: **when a fix has to be applied in
more than one place, move it somewhere it only has to be applied once.**

### Baselines

- **Lint: 31 warnings, 0 errors.** Warnings are a held baseline, not a backlog. A
  change that adds one should fix one; a change that removes one is fine but
  should be mentioned in the changelog.
- **Unit: 421 tests. Integration: 164 tests.** Both must go up, not sideways, for
  a release.
- `exactOptionalPropertyTypes` is on. An optional field cannot be assigned an
  explicit `undefined`; omit the key instead.

### The mutation harness

`scripts/mutate-phase*.sh` proves the tests are load-bearing by breaking the code
on purpose and asserting the suite notices. Run it before trusting a new test.

```bash
bash scripts/mutate-phase7.sh
bash scripts/mutate-task17.sh
```

Two rules learned the hard way, both of which produce **false passes**:

1. **Every `sed` expression must be type-valid.** The integration suite is
   transpiled, not typechecked, so a mutation that references a helper it did not
   import dies of a `ReferenceError` and the script reports "ok" for a test that
   never exercised anything.
2. **Do not nest `s///` inside a range address.** Use the `{ /pat/d }` block form.
   The script's `cmp` guard only catches no-match patterns, so a silently
   malformed mutation reads as a passing mutation.

The same reasoning applies to the static guards in `src/layers.test.ts`: a rule
that has never failed has not been shown to work. Each one was checked by
injecting a real violation and requiring the suite to go red — one of them
(`lib/` must not import `@/app`) passed against a live violation until the
specifier match was fixed, which is exactly the bug a hand-written tree guard
hides.

`src/mutation-harness.test.ts` is the same idea applied to the harnesses
themselves: it applies every `sed` expression in all four scripts to the file it
names and requires each one to change it. It cannot tell whether a mutation
makes a test fail — only a real run can — but it runs in seconds, so a pattern
that has drifted from the code fails the unit suite rather than waiting for
whoever next remembers to run a thirty-minute harness. That is not hypothetical:
`mutate-phase6.sh` had a dead pattern from Phase 8 until 2026-09-30.

**These harnesses are not in CI**, and `pnpm release:check` is where that is
accounted for: it reads a date from `.mutation-harness-verified` and refuses to
pass if the tree has changed since. Run the four scripts, then write the date.

### Browser accessibility smoke

`pnpm e2e:smoke` starts a dev server and runs `e2e/a11y.spec.ts` against the
critical flows: landing, pricing, privacy, login, and signup into the dashboard
shell. It needs a migrated Postgres — point `TEST_DATABASE_URL` at one, or the run
fails rather than silently skipping.

**Why this is separate from `pnpm lint`.** `eslint-plugin-jsx-a11y` inspects JSX,
so it catches a `div` doing a button's job. It cannot see anything that only
exists in the rendered page:

| What | Found by |
|---|---|
| `aria-label` on a bare `<span>` — prohibited by ARIA, so ignored | axe |
| Icon-only button with no accessible name (`button-name`, critical) | axe |
| Text at 2.98:1 against its background | axe (computed styles) |
| Content unreachable by Tab | `expectKeyboardReachable` |
| Reduced motion not reaching a CSS keyframe | `emulateMedia` |

Every one of those existed in this codebase and passed `jsx-a11y`.

**The opacity floor.** Muted text is `text-muted-foreground` at some opacity. The
sidebar sits on a darker background than the token, so:

| Opacity | Contrast on the sidebar background | |
|---|---|---|
| `/70` | 3.61:1 | fails — this was the bug |
| `/80` | 4.35:1 | fails |
| `/85` | 4.79:1 | the floor for body text |
| `/100` | 6.16:1 | fine |

Use `/85` or higher for anything that reads as text. `/50` and below is for
decorative icons only, and the smoke test does not assert on those.

**Dark is the default theme**, and the two palettes invert — in dark mode the same
`--gold-*` step is a *brighter* colour, so white-on-gold fails there while
dark-on-gold fails in light mode. Contrast has to be measured in both, and
`theme-provider.tsx` says which one a first-time visitor gets.

`src/lib/palette-contrast.test.ts` enforces this without a browser: it walks every
`.tsx`, reads each file's own `text-gold-N … dark:text-gold-M` class strings, and
requires both halves to clear 4.5:1 against the surface that element actually sits
on. Surfaces that are dark in *both* themes — the dashboard rail, the signed-in
user chip — are listed explicitly, because adding one is a decision rather than a
silent exception.

**`dark:` follows the class, not your OS.** Tailwind's default compiles `dark:` to
`prefers-color-scheme`, but this app themes via a `dark` class on `<html>`. The
`@custom-variant` at the top of `globals.css` aligns them; without it every
`dark:` utility in the app is driven by the operating system while the colour
tokens around it follow the toggle.

**Two shapes need different checks.** A *filled* gold button puts neutral text on
a gold fill, so the thing that must clear 4.5:1 is the background — invisible to a
`text-gold-N` pair check, and two mutations slipped past until that test existed.

### The bundle budget

`node scripts/bundle-budget.mjs` measures the gzipped first-load JS of every
prerendered route and fails if one exceeds its limit. It runs in CI after the
build, because it measures the build's own output.

```bash
pnpm bundle:budget              # check
pnpm bundle:budget -- --report  # print the table, never fail
pnpm bundle:budget -- --update  # re-baseline (read the diff before committing)
```

Two things to know before changing it. It reads the `<script src>` tags out of
each route's emitted HTML, **not** the per-route build manifest — Turbopack's
manifest holds only the shared `rootMainFiles`, which are identical for all 49
routes, so a budget computed from it would compare one number against itself.
And `--update` writes the measurement *plus 15%*, because a budget set to
today's exact size fails on the next byte of ordinary growth, which teaches
everyone to re-baseline instead of fixing regressions.

---

## 4. Layout

```
src/
  app/
    (dashboard)/        Authenticated screens. Layout holds the session check.
    actions/            "use server" — every one is an authorization boundary.
    api/                Route handlers: cron, webhooks, OAuth callbacks.
    docs/               The user guide rendered in-app.
  db/
    schema.ts           The single schema. Drizzle.
  lib/
    runtime/            The execution engine. state → plan → executor → approval.
    dashboard/          Read models for the dashboard/analytics screens, ADR-008.
    inbox/types.ts      Inbox DTOs; there is no inbox table, so no row to infer.
    connectors/         One module per platform, behind a capability contract.
    chat.ts             Assistant persistence, owner-scoped per ADR-008.
    crypto.ts           AES-256-GCM for every stored secret.
    http.ts             Outbound HTTP with a deadline. The only `fetch` allowed.
    secret-key.ts       `AUTH_SECRET` reading, for both runtimes.
    oauth-state.ts      Signed, expiring OAuth `state`.
  proxy.ts              Edge middleware: session check, auth-POST throttle.
tests/
  integration/          Real Postgres, real migrations, one container per file.
```

**`"use server"` actions are authorization boundaries.** A server action is
reachable by anyone who can craft a POST. Every one resolves the session itself
and scopes every query by `userId`; none trusts a hidden field, a referrer, or
the fact that the UI would not have shown the button.

**A `"use server"` module exports RPC endpoints and nothing else.** Every export
becomes something the browser can invoke, so its contract is async functions. A
DTO declared in one is a contract in a module that does not describe contracts,
and it is what makes a client component depend on the transport layer to
describe a *row*. So: **domain data lives with its service in `lib/`, and the
action re-exports the type.** An action's own result shape — the type
`useActionState` holds for it — legitimately stays, because no service returns
it. `src/layers.test.ts` enforces all of this by scanning the tree, and fails on
a new violation rather than on a restated list.

---

## 5. Testing conventions

- **Unit tests live next to the code** as `foo.test.ts`, and test `src/**/*.test.ts`
  only. The vitest config aliases `server-only` to a mock, so a `server-only`
  module is unit-testable; use that rather than moving logic to make it testable.
- **Integration tests live in `tests/integration/`** and are named for the
  property, not the module. `"does not let a second invocation take a step that is
  still running"` says what broke; `"claimStep"` does not.
- **Test the property, not the call.** A test that asserts a function was called
  passes when the function does the wrong thing. The Phase 7 `goals.test.ts` bug
  was a test that asserted a hardcoded `nextFiringAt` and only passed between
  midnight and 06:30 Berlin; the fixed test asserts the *property* (06:30 in the
  schedule's own timezone, and in the future) and is DST-correct.
- **Prove the guard.** After writing a test that should fail, make it fail. If you
  cannot describe the mutation that would break it, it may not be testing much.

---

## 6. Secrets

Full runbook: [`security.md`](security.md). The short version:

- Never copy a secret *value* into a ticket, log, plan, document, or commit.
  Refer to secrets by **name only**.
- `ENCRYPTION_KEY` must be **identical in every environment sharing a database**.
  Rotating it invalidates every stored token for every user; there is no
  re-encryption path. Generate with `openssl rand -hex 32`.
- `AUTH_SECRET` may differ between environments. Rotating it re-logs everyone in.
- Both are checked for **presence and strength** in production. A short secret
  now fails startup rather than silently producing a working deployment that
  signs or encrypts with something guessable.
- Outbound URLs carry `?access_token=…`. Never build an error message, a log line,
  or a support-facing string from a full URL — `HttpTimeoutError` reports the
  host only, for this reason.

---

## 7. Adding a platform or a tool

- **A platform** implements the connector contract and declares its capabilities.
  See [`connectors.md`](connectors.md) and
  [`platform-development.md`](platform-development.md). The registry entry, not
  the call site, decides whether a platform needs an authorize step, uses PKCE, or
  collects credentials manually.
- **A tool** declares `sideEffect`, which is what makes it approvable. A tool
  that reaches the network on the user's behalf and is *not* marked as a side
  effect will publish unattended, and nothing in the type system will complain.
  See [`ai/tools.md`](ai/tools.md) and [`runtime/permissions.md`](runtime/permissions.md).

Every outbound request goes through `fetchWithTimeout`. A bare `fetch(` fails
`src/lib/http.test.ts`, which is the point: `fetch` waits forever by default, and
publishing is sequential within a run, so one hung call is a run that never
settles.
