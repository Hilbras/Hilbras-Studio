# Quick Start: Connect Instagram to Hilbras Studio

## Prerequisites
- A Meta/Facebook developer account (free): https://developers.facebook.com/
- An Instagram Professional account (Business or Creator) — personal accounts don't work

## Step 1: Create the App

1. Go to https://developers.facebook.com/
2. Click **"My Apps"** → **"Create App"**
3. Select **"Other"** → Continue
4. App name: `Hilbras Studio` → Create App

## Step 2: Add the Instagram Product

1. In your new app dashboard, click **"Add Product"**
2. Find **"Instagram"** → Click **"Set Up"**
3. You need the **"API setup with Instagram login"** flow — it publishes content and
   manages comments for Instagram professional accounts.
   - This API uses *Instagram Login*, so **no Facebook Page is required** and the
     Instagram account itself signs in during connect.
   - Do **not** use the retired *Instagram Basic Display* product: it is read-only
     and cannot publish.

## Step 3: Get Your Credentials

1. Go to **Instagram** → **API setup with Instagram login**
2. Open **3. Set up Instagram business login** → **Business login settings**
3. Copy:
   - **Instagram app ID** → this is your `INSTAGRAM_CLIENT_ID`
   - **Instagram app secret** → click "Show" → this is your `INSTAGRAM_CLIENT_SECRET`
   - (the **Embed URL** is not needed — Hilbras Studio builds the authorization URL itself)

## Step 4: Configure Redirect URI

1. Stay in **Instagram** → **API setup with Instagram login** → **3. Set up Instagram business login** → **Business login settings**
2. Under **OAuth redirect URIs**, add exactly:
   ```
   http://localhost:3000/api/connect/instagram/callback
   ```
3. For production later, add:
   ```
   https://yourdomain.com/api/connect/instagram/callback
   ```
4. The redirect URI must match the one Hilbras Studio sends, character for character,
   or Meta rejects the token exchange with "Matching code was not found or was already used".

## Step 5: Add Tester (for local testing)

1. Go to **Roles** → **Users & Tasks** → **Add or Remove Users**
2. Add your Facebook account as a **Developer** or **Tester**
3. Without this, only admins can test the app

## Step 6: Configure the Credentials

Either set them in `.env.local`:

```bash
INSTAGRAM_CLIENT_ID=1234567890123456
INSTAGRAM_CLIENT_SECRET=your_instagram_app_secret
APP_URL=http://localhost:3000
```

…or sign in and save them in **Settings → Accounts**, which stores them encrypted
per user in the database. Credentials saved in the UI take precedence over env vars,
and each user's connect attempt uses that user's own app credentials.

## Step 7: Restart Server & Test

```bash
pnpm dev
# Open http://localhost:3000/accounts
# Click "Connect" on Instagram
# You should see Instagram login → permission dialog → back to Hilbras
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `platform credentials not configured` / `credentials_missing` | Set `INSTAGRAM_CLIENT_ID` + `INSTAGRAM_CLIENT_SECRET` in `.env.local`, or save them in **Settings → Accounts** as the signed-in user |
| "invalid_client" | Instagram app ID or secret is wrong, or the app is unpublished |
| "unsupported grant type" | Make sure you're using the correct token endpoint (see `.env`/registry: `api.instagram.com/oauth/access_token` for the code exchange) |
| Instagram says "This app is not ready" | Add your account as a Tester in the app dashboard |
| `instagram_personal_only` | The account that signed in is a personal profile — switch it to Business/Creator |
| `token_exchange_failed:400` with "Matching code was not found" | The redirect URI in the app dashboard doesn't match `APP_URL/api/connect/instagram/callback` |
| Publishing fails with "requires an image or video" | Instagram has no text-only posts: attach a publicly reachable `image_url` |
| Connection works, then fails after ~1 hour | The short-lived token was not upgraded. Check the server log for `[instagram] long-lived token exchange failed` — usually a wrong app secret |

## Important Notes

- ⚠️ Instagram **only** works with **Professional/Business accounts**, not personal profiles
- ⚠️ The app must be in **Development mode** to test (which is default when you create it)
- ⚠️ For production, you'll need to submit the app for **App Review** to get public access
- 🔑 The code exchange returns a **short-lived (1 hour)** token. Hilbras Studio immediately
  exchanges it for a **long-lived (60 day)** token via `graph.instagram.com/access_token`,
  which is what gets stored — so a connected account keeps working after an hour.
  Long-lived tokens must be refreshed within 60 days (`refresh_access_token`).
- 🔒 Tokens are encrypted with AES-256-GCM before storing in the database
- 📤 Publishing uses `graph.instagram.com` (Instagram Login host) with the Instagram-scoped
  user ID stored at connect time — media containers are created, polled until `FINISHED`,
  then published.
