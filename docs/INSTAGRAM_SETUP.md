# Instagram OAuth Setup Guide

## Step 1: Create Meta Developer App
1. Go to https://developers.facebook.com/
2. Click "My Apps" → "Create App"
3. Select "Business" or "Other" → Continue
4. Give it a name like "Hilbras Studio"

## Step 2: Add Instagram Product
1. In your app dashboard, click "Add Product"
2. Find "Instagram" → Click "Set Up"
3. Choose the **"API setup with Instagram login"** flow (Content publishing + comment
   moderation for professional accounts). The retired *Instagram Basic Display* product
   is read-only and cannot publish.

## Step 3: Get Credentials
1. Go to **Instagram** → **API setup with Instagram login**
2. Open **3. Set up Instagram business login** → **Business login settings**
3. Copy the **Instagram app ID** and **Instagram app secret**
4. You'll need these for `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET`
   (or save them in the app under Settings → Accounts, which stores them per user)

## Step 4: Configure Redirect URI
1. In **Business login settings**, find **OAuth redirect URIs**
2. Add redirect URI: `http://localhost:3000/api/connect/instagram/callback`
3. For production: `https://yourdomain.com/api/connect/instagram/callback`

## Step 5: Add to .env.local
```bash
INSTAGRAM_CLIENT_ID=your_app_id_here
INSTAGRAM_CLIENT_SECRET=your_app_secret_here
APP_URL=http://localhost:3000
```

## Step 6: Test
1. Restart server
2. Go to `/accounts`
3. Click "Connect" on Instagram card
4. You should see Instagram login → permission dialog → back to your app

## Important Notes
- Instagram only works with **Professional/Business accounts**, not personal profiles
- The app needs to go through Facebook App Review before public use
- For local testing, you can add your Meta account as a tester in the app dashboard
