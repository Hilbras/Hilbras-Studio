## What this changes

<!-- One or two sentences. If this closes an issue, say which. -->

## Why

<!-- The problem being solved. Link the plan/ADR: ADR-00X in docs/architecture.md. -->

## Layer

<!-- Which architectural layer does this touch? See docs/architecture.md §2.1.
     Dependencies must point downward only; nothing in src/lib/** may be
     imported by a client component. -->

- [ ] Studio UI (`src/app`, `src/components`)
- [ ] Interface (`src/app/actions`, `src/app/api`)
- [ ] Services / Domain (`src/lib`)
- [ ] Runtime (`src/lib/runtime`)
- [ ] Connectors (`src/lib/connectors`)
- [ ] Accounts & Connections
- [ ] AI Layer
- [ ] Infrastructure (`src/db`, `src/proxy.ts`)

## Checklist

- [ ] Tests added or updated. `pnpm test` and `pnpm test:integration` pass.
- [ ] `pnpm typecheck` and `pnpm lint` pass.
- [ ] `pnpm build` succeeds.
- [ ] A migration is included if the schema changed, and it is **additive** —
      contract/destructive changes are deferred to a later release (ADR-007).
- [ ] Documentation updated **in this PR** for any architectural or
      user-facing change (`docs/*.md` for developer docs, `src/app/docs/*` for
      the public guide).
- [ ] `CHANGELOG.md` updated under `[Unreleased]`, and `package.json` version
      bumped if this completes a phase (ADR-007).
- [ ] No secret values in code, logs, fixtures, or screenshots — name them only
      (see `docs/security.md`).

## Side effects

<!-- Anything that reaches outside this repo: a platform API, a queue, a
     migration, a published package, a deploy. If a step can dispatch to a real
     platform, say so — and whether the new path is idempotent (ADR-005). -->

## Risk

<!-- What breaks if this is wrong, and how it would be noticed. -->
