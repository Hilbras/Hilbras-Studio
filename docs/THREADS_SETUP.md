# Connect Threads to Hilbras Studio

Threads uses **Meta's OAuth** — the same app you create for Instagram.

## Quick Setup

### Step 1: Create Meta Developer App
1. Go to https://developers.facebook.com/
2. Click **"My Apps"** → **"Create App"**
3. Select **"Business"** or **"Other"** → Continue
4. Name it: `Hilbras Studio`

### Step 2: Add Both Instagram & Threads Products
1. In your app dashboard, click **"Add Product"**
2. Find and set up **Instagram** (Graph API)
3. Find and set up **Threads** (click "Set Up")

### Step 3: Get Credentials
1. Go to **Settings** → **Basic**
2. Copy your **App ID** and **App Secret**
3. Add to `.env.local`:
   ```bash
   INSTAGRAM_CLIENT_ID=your_app_id
   INSTAGRAM_CLIENT_SECRET=your_app_secret
   THREADS_CLIENT_ID=your_app_id
   THREADS_CLIENT_SECRET=your_app_secret
   APP_URL=http://localhost:3000
   ```

### Step 4: Configure Redirect URIs
In your app settings, add these redirect URIs:
```
http://localhost:3000/api/connect/instagram/callback
http://localhost:3000/api/connect/threads/callback
```

### Step 5: Add Testers
1. Go to **Roles** → **Users & Tasks**
2. Add your Facebook account as a **Developer** or **Tester**

### Step 6: Restart & Test
```bash
pnpm dev
```
Then go to `/accounts` → Click "Connect" on Threads.

## Important Notes

- Threads only works with **Threads accounts linked to Instagram Professional accounts**
- You need an Instagram Professional (Business/Creator) account first
- The Threads connection shares the same Meta app as Instagram
- For production, submit both apps for review

## Troubleshooting

| Error | Fix |
|-------|-----|
| "platform credentials not configured" | Check `THREADS_CLIENT_ID` and `THREADS_CLIENT_SECRET` are set |
| "missing_code_or_state" | Make sure redirect URI is registered in Meta app |
| "thread_not_connected" | You need an Instagram Professional account first |
