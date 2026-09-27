# Accounts

An **account** is an identity on a platform. It is what a Goal targets, and what
a plan's steps name. Introduced in **Phase 2** (v0.4.0).

Grants and tokens: [`connections.md`](./connections.md).
Token lifecycle: [`authentication.md`](./authentication.md).

Source: `src/db/schema.ts`, `src/lib/accounts/store.ts`.

---

## Why this exists

Before Phase 2 there was no account. One `social_accounts` row held a token
*and* a `platform_account_id`, with no unique constraint, and both OAuth
callbacks ran:

```ts
await db.delete(socialAccounts).where(
  and(eq(userId), eq(platform))
);
await db.insert(socialAccounts).values({ ... });
```

The consequence was stronger than "the newest connection wins": **connecting a
second account on a platform destroyed the first.** Not unreachable — deleted.
And the publish path then picked whichever row was newest
(`.orderBy(connectedAt).limit(1)`), so even rows that survived were ambiguous.

---

## The model

```
Connection  (a grant: tokens, expiry, refresh state)
     │
     ├──▶ Account  x:hilbras      enabled
     ├──▶ Account  x:hilbrasai    enabled
     └──▶ Account  x:personal     disabled
```

| Table | Holds | Unique on |
|---|---|---|
| `connections` | encrypted tokens, expiry | *(nothing)* — a user may hold several grants per platform |
| `accounts` | identity, handle, enabled, capabilities | `(user_id, platform, platform_account_id)` and `(user_id, account_key)` |

`connections` is deliberately **not** unique on `(user_id, platform)`. Two
different logins on the same platform are two grants, and one grant may cover
several accounts — a single Facebook login can authorise multiple Pages.

---

## `account_key`

The stable reference everything else uses: **`platform:handle`**, e.g.
`x:hilbras`. Unique per user, not globally.

Goals store these in `goals.target_accounts`, plan steps carry them in
`run_steps.target_account`, and `post_targets.account_key` records which
account a post went to.

`account_key` is NULL for a post aimed at a platform rather than a specific
account — which is all the Composer can express today, since it offers platforms
and not accounts. The column exists so that per-account targeting does not need
another migration, and the uniqueness constraint covers it (see
[below](#migration-status)).

An account with no handle falls back to its platform id rather than producing a
bare `x:`, which would collide across every handle-less account.

---

## `enabled` is intent, not health

A disabled account is **skipped by plan validation**, which reports
`account_disabled` before the run starts. It is not silently dropped, because a
step that vanishes mid-plan is far harder to explain than one that is refused up
front.

Turning an account off never affects the others on the same platform, and never
removes its tokens — you can turn it back on.

Health is a separate question. `listAccountsNeedingAttention()` reports accounts
whose grant has expired or has no token, as `expired` or `no_token`. Those are
connectivity problems, not user decisions, and they are not the same thing as
`enabled: false`.

---

## Capabilities are per-account

`accounts.capabilities` is a JSON array of capability names, and it is
**narrower than the platform's set** — a Facebook profile and a Facebook Page
are not the same account type and cannot do the same things.

Resolution order:

1. the account's stored set, if present
2. the platform's registry capabilities
3. `[]` for a connect-only platform

Connect-only platforms therefore resolve to an **empty** set rather than
disappearing. `resolveAccount()` still returns them, so the UI can show them and
say "connect-only", while `listSelectableAccounts(userId, "publish_post")`
correctly excludes them.

---

## Three guarantees

**Connecting never destroys.** A reconnect upserts the accounts the grant
reaches and repoints them at the new grant. Other accounts on the same platform
are untouched.

**An account is identified, not guessed.** The unique constraints mean
"which account is this?" is answerable exactly. There is no `limit(1)`.

**Ownership is enforced in the query.** Every read and write takes `userId` and
filters on it. `resolveAccount(bob, "x:hilbras")` returns Bob's account or
nothing — never Alice's, even though the key is identical.

---

## Migration status

`0008_accounts_and_connections` creates `connections`, `accounts`, and
`post_targets`, and **backfills** from `social_accounts` and `posts.platforms`.
It alters nothing existing.

`0010_drop_social_accounts` dropped `social_accounts`, guarded by a row-count
check that aborts if the 0008 backfill is incomplete.

`0011_post_targets_contract` completes the switchover: it backfills any target
rows missed since 0008, collapses duplicates, adds
`UNIQUE NULLS NOT DISTINCT (post_id, platform, account_key)`, and then drops
`posts.platforms`. It aborts if any post would be left with no target row — the
old column is still intact at that point, so the backfill can be re-run by hand.

Both contractions are now done. `post_targets` is the only record of where a post
goes, written in the same transaction as the post itself
(`src/lib/posts/service.ts`).

The OAuth callbacks now write through `registerConnection()`, so the two writers
that briefly coexisted can no longer disagree.
