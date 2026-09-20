# Quick Start: Connect Instagram to Hilbras Studio

## Prerequisites
- A Meta/Facebook developer account (free): https://developers.facebook.com/
- An Instagram Professional account (Business or Creator) — personal accounts don't work

## Step 1: Create the App

1. Go to https://developers.facebook.com/
2. Click **"My Apps"** → **"Create App"**
3. Select **"Other"** → Continue
4. App name: `Hilbras Studio` → Create App

## Step 2: Add Instagram Product

1. In your new app dashboard, click **"Add Product"**
2. Find **"Instagram"** → Click **"Set Up"**
3. You'll see two options:
   - **Instagram Basic Display** (read-only profile data)
   - **Instagram Graph API** (publish content, manage comments)
4. Set up **both** — you need Graph API for publishing

## Step 3: Get Your Credentials

1. In the left sidebar, click **Settings** → **Basic**
2. Copy:
   - **App ID** → this is your `INSTAGRAM_CLIENT_ID`
   - **App Secret** → click "Show" → this is your `INSTAGRAM_CLIENT_SECRET`

## Step 4: Configure Redirect URI

1. Go to **Instagram** → **Basic Display** settings (left sidebar)
2. Under **Redirect URIs**, add:
   ```
   http://localhost:3000/api/connect/instagram/callback
   ```
3. For production later, add:
   ```
   https://yourdomain.com/api/connect/instagram/callback
   ```

## Step 5: Add Tester (for local testing)

1. Go to **Roles** → **Users & Tasks** → **Add or Remove Users**
2. Add your Facebook account as a **Developer** or **Tester**
3. Without this, only admins can test the app

## Step 6: Update .env.local

```bash
INSTAGRAM_CLIENT_ID=1234567890123456
INSTAGRAM_CLIENT_SECRET=abcdef1234567890abcdef1234567890
APP_URL=http://localhost:3000
```

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
| "platform credentials not configured" | Check `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` are set in `.env.local` |
| "invalid_client" | App ID or Secret is wrong, or app is unpublished |
| "unsupported grant type" | Make sure you're using the correct token endpoint |
| Instagram says "This app is not ready" | Add your account as a Tester in the app dashboard |

## Important Notes

- ⚠️ Instagram **only** works with **Professional/Business accounts**, not personal profiles
- ⚠️ The app must be in **Development mode** to test (which is default when you create it)
- ⚠️ For production, you'll need to submit the app for **App Review** to get public access
- 🔒 Tokens are encrypted with AES-256-GCM before storing in the database
