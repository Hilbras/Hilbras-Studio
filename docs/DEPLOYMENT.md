# Deploying Hilbras Studio (Vercel + Supabase)

The app is a Next.js server app: the OAuth callbacks, token encryption and the
platform publishers all run in Vercel Functions, and every row lives in Postgres
(Supabase). This document covers the pieces that are specific to that setup.

## 1. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production
and Preview) *and* keep them in `.env.local` for local development.

| Variable | Notes |
|---|---|
| `APP_URL` | Public base URL, no trailing slash — `https://hilbras-studio.vercel.app`. Used to build OAuth redirect URIs. |
| `AUTH_SECRET` | JWT signing key. `openssl rand -hex 32`. |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored tokens. `openssl rand -hex 32`. **Must be identical everywhere that shares the database** — see below. |
| `DATABASE_URL` | Supabase **Session pooler** URL (see below). |
| `CRON_SECRET` | Random string. Authorises the scheduled-post cron endpoint. `openssl rand -hex 32`. |
| `THREADS_CLIENT_ID` / `THREADS_CLIENT_SECRET` | Threads app pair from the Threads use case (see `docs/THREADS_SETUP.md`). |
| `INSTAGRAM_*`, `FACEBOOK_*`, `X_*`, … | Same pattern per platform. |

Platform credentials can also be saved per user in **Settings → Accounts**, which
stores them encrypted in the database; a saved value wins over the env var.

### ⚠️ `ENCRYPTION_KEY` must match across environments

User OAuth tokens and platform credentials are encrypted at rest with
`ENCRYPTION_KEY`. If local development and the deployment share one Supabase
database but use **different** keys, each side can only decrypt the rows it wrote
itself — connections created locally look "missing" in production and vice versa
(`decryptSecret` fails and the connection is treated as absent). Rotating the key
invalidates every stored token, so generate once and copy it to every
environment.

`AUTH_SECRET` is safe to differ: sessions are cookies held by the browser, and
passwords are bcrypt hashes in the database, so accounts still log in on both.

## 2. Supabase connection string

Use the **Session pooler**, not the direct `db.<ref>.supabase.co` host: direct
connections are IPv6-only and are not reachable from Vercel Functions. From
**Supabase → Settings → Database**, the string looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
```

Port `5432` is the session pooler (port `6543` is transaction mode, which breaks
the `pg` driver's prepared statements).

The schema is created by Drizzle from `src/db/schema.ts`:

```bash
npx drizzle-kit push
```

Running it more than once is safe — it only applies differences.

## 3. Scheduled posts

Posts saved with a future time are stored as `status = "scheduled"` and published
later by `src/lib/scheduled-posts.ts`. There is no in-process scheduler, because
Vercel Functions only run in response to a request, so the runner is triggered by:

1. **Vercel Cron** → `GET /api/cron/publish-scheduled`, configured in
   `vercel.json`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically
   once `CRON_SECRET` is set on the project.
2. **The Scheduler's "Publish due now" button** → the same runner, scoped to the
   signed-in user. Useful on Hobby and after a failed run.

### Cron frequency is plan-limited

| Plan | Allowed schedule | `vercel.json` entry |
|---|---|---|
| Hobby | **Once per day only** | `"schedule": "0 9 * * *"` (the committed default) |
| Pro | Once per minute | `"schedule": "*/5 * * * *"` (use this for on-time publishing) |

A sub-daily expression on a Hobby project **fails deployment** with
`Hobby accounts are limited to daily cron jobs`. That is why the committed
schedule is daily; on Pro, change it to `*/5 * * * *`. On Hobby, use the
"Publish due now" button (or upgrade) so a post scheduled for 14:30 is not held
until the next daily run. Hobby cron timing is also imprecise — a job set for
09:00 may start anywhere up to 09:59.

Each run claims posts with a conditional update before publishing, so an
overlapping cron run and button click cannot post the same content twice. A post
stuck in `publishing` (for example a timed-out invocation) is automatically
re-queued after 10 minutes.

### Terminal statuses

A post ends up `published` when **at least one** target platform accepted it, and
`failed` when every one of them refused; `results` holds the per-platform detail
either way. Both the Composer (`recordPublishOutcome` in `src/app/actions/posts.ts`)
and the runner (`finalize` in `src/lib/scheduled-posts.ts`) apply that same rule —
so a publish that a platform rejected is never reported as live in the queue.

## 4. Platform OAuth redirect URIs

For every platform you connect, register the callback in that platform's
developer console using the deployed `APP_URL`:

```
{APP_URL}/api/connect/{platform}/callback
```

Threads additionally needs the deauthorization and data-deletion callbacks:

```
{APP_URL}/api/connect/threads/deauthorize
{APP_URL}/api/connect/threads/delete
```

See `docs/THREADS_SETUP.md` and `docs/INSTAGRAM_SETUP.md` for the per-platform
walkthroughs. Meta requires an exact match — including scheme, host and port.

## 5. Deploy checklist

1. Set every variable from §1 in Vercel (Production + Preview), including
   `CRON_SECRET`.
2. Apply the schema with `npx drizzle-kit push` against the Supabase URL.
3. Deploy (`git push` on a connected project, or `vercel --prod`).
4. Visit `/accounts` and connect a platform; the OAuth `APP_URL` is taken from the
   env var, so the redirected host must equal the one registered in §4.