# Security

Operational runbook for secret handling and rotation. This is the
[remediation Task 0](https://github.com/Hilbras/Hilbras-Studio) deliverable
referenced in `docs/architecture.md` §6.

**Rule: never copy a secret *value* into a ticket, log, plan, document, or
commit.** Everything below refers to secrets by **name only**.

---

## 1. Secret inventory

Names only. Grouped by what breaks when the value changes.

### Session and database

| Variable | Protects | On rotation |
|---|---|---|
| `AUTH_SECRET` | HS256 session signing **and** the HMAC on the OAuth `state` | All sessions invalidated; users re-login. In-flight connect flows fail. Safe on its own. |
| `ENCRYPTION_KEY` | AES-256-GCM for every stored token and credential | **Every stored token becomes unreadable.** See the warning below. |
| `DATABASE_URL` | Postgres connection | Sessions survive — the cookie is client-held and the password hash is in the DB. |

> ### ⚠️ `ENCRYPTION_KEY` is the one that hurts
>
> It must be **identical in every environment that shares a database** — local
> development, preview, and production. If two environments use different keys,
> each can only decrypt the rows it wrote itself: connections created locally
> look "missing" in production and vice versa (`decryptSecret` fails and the
> connection is treated as absent).
>
> Rotating it invalidates every stored OAuth token and platform credential for
> every user. There is no re-encryption path — **all users must reconnect their
> accounts.** Generate it once with `openssl rand -hex 32` and copy it to every
> environment.
>
> The reason there is no re-encryption path is that the stored payload carries
> no key identifier. `base64url(iv).base64url(authTag).base64url(ciphertext)`
> says nothing about which key made it, so a reader holding two keys has nothing
> to try and cannot tell a rotation from tampering. Adding a `kid` and a dual-key
> read path is the fix and is deliberately **not** in v0.9.5: it changes the
> format of every stored secret, needs a migration, and a bug in the migration is
> unrecoverable in a way that a missing feature is not.
>
> `AUTH_SECRET` is safe to differ between environments.

### Minimum strength (v0.9.5)

Both secrets are checked for **presence and length** at startup in production. A
secret shorter than 32 characters throws with the command to generate a proper
one.

This closes a real gap. Until v0.9.5 only *presence* was checked, so
`ENCRYPTION_KEY=a` and `AUTH_SECRET=x` were both valid production configurations
— the deployment started, encrypted or signed every token and every session
cookie with something derived from one character, and nothing reported a problem.
A JWT signed with a guessable key is forgeable by anyone who has ever seen a
cookie, and the tokens still verify, so nothing looks wrong.

Reading `AUTH_SECRET` lives in exactly one module,
[`src/lib/secret-key.ts`](../src/lib/secret-key.ts), because it was previously
written out twice — in `proxy.ts` and `lib/session.ts` — and a fix to one of them
would not have reached the other.

### Scheduled publishing

| Variable | Protects | On rotation |
|---|---|---|
| `CRON_SECRET` | Authorises `GET /api/cron/publish-scheduled` | Update in Vercel and any other caller together, or the cron stops publishing. Fails closed when unset. |

### AI providers

| Variable | Protects | On rotation |
|---|---|---|
| `HILBRAS_AI_API_KEY` | The built-in "Hilbras AI" model | Update in all environments together or users silently fall back. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Fallbacks for the built-in model | As above. |
| Per-user provider keys | `stored_credentials` | Rotated per user in **Settings → AI Providers**; encrypted with `ENCRYPTION_KEY`. |

`GROQ_API_KEY` appears in some local `.env.local` files but is **not read by the
application** and is not listed in `.env.example`. It can be removed.

### Platform credentials

`{PLATFORM}_CLIENT_ID` / `{PLATFORM}_CLIENT_SECRET` for Instagram, Facebook,
Threads, X, LinkedIn, TikTok, YouTube, Pinterest, and Reddit. These are
deployment-level by default, but users may override them per user in
**Settings → Accounts**, where they are encrypted with `ENCRYPTION_KEY`.

Rotating a client secret invalidates the *authorization grant*, not just the
secret — users connected through that app must reconnect. Coordinate the
rotation with the platform's app dashboard, then update every environment.

### Webhooks

| Variable | Protects | On rotation |
|---|---|---|
| `INSTAGRAM_CLIENT_SECRET` | Also signs `X-Hub-Signature-256` on `POST /api/webhooks/instagram` | Rotate at Meta first, then here — the webhook fails closed on mismatch. |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Meta's subscription handshake only | No publishing impact. Optional. |

### Signup controls

`SIGNUP_INVITE_CODE` — optional. Required when public registration is disabled
and an invite code is enforced. See `src/lib/signup-policy.ts`.

---

## 2. Local file hygiene

`.env.local` holds real credentials and must be readable only by its owner:

```bash
chmod 600 .env.local
```

`.env.example` is a tracked, placeholder-only template and should be `644`.

`.env*` is gitignored with a single negation for `.env.example`, so a secret
cannot be committed by accident through the normal path.

### Scan results (2026-09-27, revision `a718d43`)

- `.env.local` permissions were `664` (group- and world-readable) — **corrected
  to `600`**.
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` is read by the application but was missing
  from `.env.example` — **documented**.
- `GROQ_API_KEY` is present in local env but unread by the application —
  **removable**.
- No apparent credentials were found in tracked files.
- No apparent credentials were found in the scanned commit history.
- `git status` confirmed no env file, database file, or build artifact is
  staged.

### URL hygiene

Outbound URLs to Meta carry the access token in the query string
(`…/me?fields=id&access_token=…`). Those URLs must not be copied into:

- **Error messages.** `HttpTimeoutError` reports the **host only** for this
  reason; the full URL stays on the error object for a log somebody has
  consciously chosen to write. Every user-facing publish error is built from a
  platform's own error text or a status code, never from a request line.
- **Logs.** Platform identifiers and status codes are logged; URLs are not.
- **Support tickets.** A timeout is exactly the error a user pastes into one.

Construct query strings with `URLSearchParams`, not by interpolation. An
Instagram access token routinely contains `&`, `=`, `+` and `/`, and an unencoded
one silently truncates the request at the first `&` — a message list that comes
back empty with a `200`, which reads as "no new messages" rather than as a bug.
This was a live bug until v0.9.5.

---

## 3. Access control boundaries

### Scoping is in the query, not the caller

Every function that reads or writes one user's rows takes a `userId` and puts it
in the `WHERE` clause. A server action is reachable by anyone who can craft a
POST, so "the UI would not have shown the button" is not a control.

- `src/lib/runtime/queries.ts` — the only module UI code may read user data
  through (ADR-008).
- `src/lib/chat.ts` — `loadMessages`, `appendMessage`, `saveSummary` and
  `touchSession` all scope on the session's owner (ADR-010). Session ids are
  minted client-side and are therefore attacker-supplied.
- `src/app/actions/*` — `"use server"` modules are authorization boundaries. Each
  resolves the session itself.

A known id belonging to someone else is **`null`, not an error**. An error would
distinguish "does not exist" from "not yours", which is a tenant-enumeration
oracle.

### The OAuth `state` is signed

`src/lib/oauth-state.ts` signs `state` with `AUTH_SECRET` and verifies the
signature **before** parsing. Until v0.9.5 the state was unsigned base64url JSON
and the callback's only check was `state.userId === session.id` — so the entire
defence against an account-link CSRF was knowing a user id.

`state` is not single-use, and does not need to be: replaying a captured genuine
state still needs a `code` issued for that flow, and the token exchange sends the
`code_verifier` held only in an httpOnly cookie. **Signing closes the forgery;
PKCE closes the replay.** See ADR-011.

### Manual and scheduled publishes are not gated by `execution_policies`

`execution_policies` is consulted by the Runtime before it runs a step, so it
governs **AI-planned runs only**. Publishing a post directly from the composer,
or via the scheduler, does not consult it.

This is deliberate and is the one Phase 8 decision that changes what a policy
setting means. A user who sets a platform to `disabled` and then schedules a post
by hand will still see it publish. Gating those paths would have meant a manual
publish stops working for anyone holding such a policy — a visible regression in
exchange for a guarantee about a code path the policy was never designed to
govern. Recorded here and in the v0.9.5 changelog rather than left implicit.

---

## 4. What is not built yet

Named, so their absence is a decision on the record rather than an oversight.

| Gap | Why it is not in v0.9.5 |
|---|---|
| **No audit log.** Logins, failed logins, connects, disconnects, credential changes and policy changes are unrecorded. | It is a table, a migration, and writers in six places, plus a screen to read it. Half of that is worse than none: an audit log that misses the event you are investigating is worse than knowing there isn't one. |
| **No `kid` in the ciphertext**, so `ENCRYPTION_KEY` cannot be rotated. | See §1. Changes the stored format of every secret; the migration is unrecoverable if it is wrong. |
| **No outbound token revocation on disconnect.** Revoking a platform token is a third-party call per platform, and none is implemented. | Needs per-platform support/endpoints that do not all exist. |
| **No graceful shutdown.** Zero `process.on` handlers. | Needs a decision about what an in-flight publish should do when the process is asked to stop. |
| **Media is readable by UUID without authentication.** | The ids are unguessable but not secret. Fixing it means a signed or expiring URL scheme on the media route. |
| **`maskSecret` shows 4 real characters at each end.** | Below a minimum length it masks the whole value instead. A UI that wants less should not render the ends. |

---

## 5. Rotation procedure

1. **Generate** the replacement: `openssl rand -hex 32`.
2. **Update every environment that shares the database** — preview and
   production at minimum, plus local development if it points at the same DB.
3. **Deploy.** For `AUTH_SECRET` no redeploy ordering is needed; users simply
   re-login.
4. **For `ENCRYPTION_KEY`: do not do this casually.** It logs every user out of
   their connected accounts. Announce it, and expect a reconnect spike.
5. **Verify** with the checklist below.

### Post-rotation verification

- [ ] Sign in works; a stale cookie redirects to `/login?reauth=1` rather than looping.
- [ ] A previously connected account still shows as connected
      (Settings → Accounts).
- [ ] A manual **Publish due now** run succeeds, or fails with
      `not_connected` — never a raw decrypt error.
- [ ] The scheduled-post cron returns 200 with `CRON_SECRET` set, 401 without.
- [ ] `pnpm test && pnpm test:integration` pass.

---

## 6. Reporting a suspected exposure

If a secret is ever committed, logged, or shared:

1. **Rotate first.** Assume it is compromised; do not investigate before
   revoking it.
2. Then audit usage, and record what happened in this document.

Do not paste the value into an issue, a PR, or a chat message — reference it by
name and say where it was exposed.
