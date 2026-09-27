# Connections

A **connection** is an authorization grant: a user's token for a platform, its
expiry, and its refresh state. Introduced in **Phase 2** (v0.4.0).

Accounts: [`accounts.md`](./accounts.md).
Token lifecycle: [`authentication.md`](./authentication.md).

Source: `src/db/schema.ts`, `src/lib/accounts/store.ts`.

---

## Grant, not account

A connection is *permission*. An account is *identity*. They are separate
because one grant can reach several identities, and one identity can be reached
by several grants.

```
Facebook login  ──┬──▶ Page "Hilbras"
                  └──▶ Page "Hilbras Studio"

X login #1  ──────▶ @Hilbras
X login #2  ──────▶ @HilbrasAI
```

Conflating them is what made the v0.1.0 model unworkable: it had no way to say
"this token is good, but only for that Page", and no way to hold two logins for
one platform.

---

## The table

`connections` — `id`, `user_id`, `platform`, `access_token_enc`,
`refresh_token_enc`, `token_expires_at`, `connected_at`.

**No unique constraint on `(user_id, platform)`, deliberately.** Two logins on
one platform are two grants. The v0.1.0 model's implicit "one connection per
platform" was enforced by *deleting the previous row*, which is not the same
thing and is why the second account was lost.

### Encrypted at rest

`access_token_enc` and `refresh_token_enc` hold AES-256-GCM ciphertext, written
by `encryptSecret` and read by `decryptSecret` in `src/lib/crypto.ts`. Plaintext
tokens are never stored, and never leave the server-only layer.

`ENCRYPTION_KEY` must be identical in every environment sharing the database.
Rotating it invalidates every stored token for every user, with no
re-encryption path — see [`security.md`](./security.md).

---

## Registering a connection

`registerConnection()` is the single write path:

```ts
await registerConnection({
  userId,
  platform: "x",
  accessTokenEnc: encryptSecret(token),
  refreshTokenEnc: refresh ? encryptSecret(refresh) : null,
  tokenExpiresAt: expiresAt,
  accounts: [{ platformAccountId: "123", handle: "hilbras" }],
});
```

It inserts the grant, then upserts each account:

- **New identity** → inserted.
- **Identity already known** → the row is kept and **repointed at the new
  grant**, so its token comes from the connection just authorised. The account
  id is stable, so anything already referencing it keeps working.
- **Key conflict with a different identity** → throws. Silently dropping an
  account the user connected is worse than a loud failure.

Nothing is deleted. That is the whole point of the change.

---

## Disconnecting

Two granularities, because they mean different things:

| Call | Effect |
|---|---|
| `disconnectAccount(userId, id)` | Removes one account. Removes the **grant** only if it was the grant's last account. |
| `disconnectPlatform(userId, platform)` | Removes every account on a platform, and their grants. |

The first is the one that matters: removing a single Facebook Page must not
revoke the login that also authorises two others. A grant is deleted only when
its last account goes.

---

## Health, distinct from liveness

An account whose grant has expired or holds no token is reported by
`listAccountsNeedingAttention()` as `expired` or `no_token`. This is a
connectivity problem, not a user decision, and it is separate from
`enabled: false` on the account.

The v0.1.0 publisher also refreshed long-lived tokens opportunistically, inside a
refresh window before expiry. That logic is unchanged and still lives in
`src/lib/platform-tokens.ts`; Phase 2 added the model, not a second refresh path.

---

## Migration status

Backfilled in `0008_accounts_and_connections`, reusing `social_accounts` ids.

The OAuth callbacks (`/api/connect/[platform]/callback` and
`actions/telegram.ts`) still write to `social_accounts`; switching them to
`registerConnection()` lands in **v0.5.0** together with the column contraction,
so the old and new writers are never live at the same time.
