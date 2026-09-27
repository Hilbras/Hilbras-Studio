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
| `AUTH_SECRET` | HS256 session signing | All sessions invalidated; users re-login. Safe on its own. |
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
> `AUTH_SECRET` is safe to differ between environments.

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

---

## 3. Rotation procedure

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

## 4. Reporting a suspected exposure

If a secret is ever committed, logged, or shared:

1. **Rotate first.** Assume it is compromised; do not investigate before
   revoking it.
2. Then audit usage, and record what happened in this document.

Do not paste the value into an issue, a PR, or a chat message — reference it by
name and say where it was exposed.
