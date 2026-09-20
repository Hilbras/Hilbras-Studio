# Connect Threads to Hilbras Studio

Threads uses **Meta OAuth**, but it is a **separate app from Instagram**: a Meta app
created with the Threads use case has *two* app IDs and *two* app secrets. Use the
**Threads** pair — pasting the Instagram credentials makes the token exchange fail
with HTTP 400.

> Meta: *"When creating your app there will be 2 app IDs and app secrets. For
> Threads API implementation purposes, use the Threads app ID and its corresponding
> app secret."*

## Prerequisites

- A **Threads** account (a Threads profile is created from an Instagram account)
- A Meta/Facebook developer account: https://developers.facebook.com/

Unlike Instagram, Threads publishing does **not** require a Business or Creator
account — any Threads profile can publish. Media you attach must be hosted on a
**publicly accessible** URL at publish time, because Meta downloads it.

## Step 1: Create the app with the Threads use case

1. Go to https://developers.facebook.com/apps → **Create App**
2. Name it (e.g. `Hilbras Studio`) and, when asked for a use case, pick
   **Access the Threads API**
3. On the **Use cases** page, open the Threads use case. `threads_basic` is
   required and cannot be removed; click **Add** next to
   **`threads_content_publish`** — Hilbras Studio needs it to publish

## Step 2: Copy the Threads credentials

In the left-side menu click **Settings** (of the Threads use case). This is where
the **Threads app ID** and **Threads app secret** are shown.

```bash
THREADS_CLIENT_ID=your_threads_app_id
THREADS_CLIENT_SECRET=your_threads_app_secret
APP_URL=http://localhost:3000
```

The app ID/secret you see on the Instagram or Facebook side of the same app are
*not* the Threads credentials.

### Or save them in the UI

**Settings → Accounts** in Hilbras Studio stores credentials per signed-in user
(encrypted). The UI value wins over the env var, and everything else in this doc
works the same either way.

## Step 3: Configure the URLs

Still in the Threads use case **Settings**, fill in three fields and click **Save**:

| Dashboard field | Value |
|---|---|
| **Client OAuth Settings** → valid OAuth redirect URIs | `{APP_URL}/api/connect/threads/callback` |
| **Deauthorize callback URL** | `{APP_URL}/api/connect/threads/deauthorize` |
| **Data Deletion Requests URL** | `{APP_URL}/api/connect/threads/delete` |

For local development:

```
http://localhost:3000/api/connect/threads/callback
http://localhost:3000/api/connect/threads/deauthorize
http://localhost:3000/api/connect/threads/delete
```

The redirect URI must match **exactly** — including scheme, host, port and path —
or Meta rejects the authorization request with `URL Blocked` (error **1349168**).
Two traps: this list belongs to the **Threads use case** (Facebook Login and
Instagram have their own, separate lists), and the dashboard sometimes **adds a
trailing slash by itself** — `…/callback/` does not match `…/callback`. Copy the
exact string from **Settings → Accounts → Configure** in Hilbras Studio: it is the
URL the connect flow will actually send.

## Step 4: Add a Threads tester

While the app is unpublished, only people with a role on it can authorize:

1. In the Threads use case Settings, click **Add or Remove Threads Test Users**
2. On **App roles → Roles**, click **Add People** and add the person as a
   **Threads Tester** (Administrator/Developer/Tester also work for your own account)
3. The invited person accepts under **Threads → Account Settings → Website
   permissions** on threads.net (or in the Threads app). The invitation is *not*
   active until they accept it

## Step 5: Connect and post

```bash
pnpm dev
```

Open http://localhost:3000/accounts → **Connect** next to Threads → authorize in
the Threads window → you land back on `/accounts?connected=threads`.

Then, in the composer, select Threads and write the post:

| Post kind | How to send it | Notes |
|---|---|---|
| **Text** | Leave Media URL empty | Limit **500 characters** (checked before the API call) |
| **Image** | Media URL ending in `.jpg`, `.png`, `.gif`, `.webp`… | Publicly reachable URL |
| **Video** | Media URL ending in `.mp4`, `.mov`, `.m4v` or `.webm` | Same `threads_content_publish` permission; processing takes longer |

## How publishing and tokens work

- **Three-step publish.** Hilbras Studio creates a media container
  (`POST /{threads-user-id}/threads`), waits for it to reach `FINISHED`
  (`GET /{container-id}?fields=status,error_message`), then publishes it
  (`POST /{threads-user-id}/threads_publish`). Meta recommends waiting *"an average
  of 30 seconds"* between the first and last call; the budget here is 30s for images
  and 60s for video. Text containers finish immediately.
- **Token lifetime.** The authorization code is exchanged for a short-lived token
  (**1 hour**) which is immediately upgraded to a long-lived token (**60 days**) via
  `graph.threads.net/access_token?grant_type=th_exchange_token`. Without that
  exchange the connection dies within the hour.
- **Refresh.** Before publishing with a connection that has under a week of life
  left, Hilbras Studio refreshes it in place
  (`/refresh_access_token?grant_type=th_refresh_token`, no app secret required) for
  another 60 days. A long-lived token must be at least **24 hours** old to be
  refreshable, and a token left unrefreshed for 60 days can no longer be refreshed.
- **Permission grants.** The user's *permission grant* lasts **90 days** and each
  refresh extends it by another 90 days — but only for **public** Threads profiles.
  For a **private** profile the grant cannot be extended, so the user must
  reconnect once it expires.
- **Rate limits.** Threads allows **250 posts** and **1000 replies** per rolling
  24 hours. The scheduler enqueues future posts without counting against this
  quota, so keep scheduled volume well below it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `credentials_missing` | No `THREADS_CLIENT_ID`/`THREADS_CLIENT_SECRET` in `.env.local` and none saved in **Settings → Accounts** for the signed-in user |
| `Authorization Failed: No app ID was sent with the request.` (error **4476002**) on threads.net, or `threads_app_id_invalid` inside Hilbras Studio | The saved client ID is the app's **Facebook/Instagram** half. The Threads API does not recognise it (`Invalid client_id`), and Meta renders that as "no app ID". Re-copy **both** values from the Threads use case → **Settings**. Note a UI-saved value **overrides** `THREADS_CLIENT_ID`, so fix it in **Settings → Accounts** — adding the env var alone changes nothing while the old row is stored |
| "Test Keys" reports the credentials are not a Threads app pair | Same cause as above. Hilbras Studio now probes the platform's token endpoint before sending you to the authorize page, so this is caught in-app instead of ending on Meta's error page |
| Token exchange fails with **400**, or `token_exchange_failed:400` after authorizing | The Instagram/Facebook app ID and secret were used instead of the Threads pair — re-copy both from the Threads use case **Settings** |
| `missing_code_or_state` / Meta shows a redirect-URI error | The redirect URI in the dashboard does not match `{APP_URL}/api/connect/threads/callback` exactly |
| `URL Blocked: This redirect failed because the redirect URI is not whitelisted in the app's Client OAuth Settings` (error **1349168**) | The redirect URI is missing from **Client OAuth Settings → valid OAuth redirect URIs** *inside the Threads use case* (Use cases → Threads → Settings). Register `{APP_URL}/api/connect/threads/callback` there and click **Save** — the Facebook Login side of the app has its own list and does not cover Threads. Copy the URL from **Settings → Accounts → Configure** to get the exact string. Removing the Facebook/Instagram URIs or adding the Threads URI to the wrong use case does not help | 
| The dashboard URL list shows a **trailing slash** you did not type | Meta's editor appends one itself, and the comparison is literal: `…/callback/` does **not** match the `…/callback` Hilbras Studio sends. Delete the slash before saving (Meta's own docs warn about this) |
| `invalid_state` or `missing_pkce_verifier` | The authorization was started in a different browser/session, or cookies were cleared mid-flow. Start over from `/accounts` |
| `no_access_token` | Meta returned no token — usually an app/secret mismatch or a redirect URI that does not match |
| "This app is not ready" in the authorization window | The account is not a Threads Tester yet, or the invitation was never accepted (see Step 4) |
| Publish works, then fails about an hour later | The long-lived exchange failed — look for `[threads] token request failed` in the server log (usually a wrong app secret) |
| Container creation succeeds but publish fails or times out | The media URL is not publicly reachable, or the format is unsupported. Check the log line `[threads] container <id> failed: <error_message>` |
| Deauthorize / data-deletion webhook returns `500 app secret not configured` | Neither `THREADS_CLIENT_SECRET` nor a UI-saved `threads_client_secret` exists. The webhook has no session, so it verifies against **every** stored secret plus the env var |
| Data-deletion webhook returns `401 invalid signature` | Meta signed with a secret we do not have — e.g. the secret was rotated in the dashboard without updating Hilbras Studio |

## Related docs

- `docs/INSTAGRAM_SETUP.md` — Instagram is a different product with different credentials
- `docs/INSTAGRAM_QUICKSTART.md` — 10-minute Instagram connect walkthrough
