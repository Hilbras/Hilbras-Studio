# Hilbras Studio

AI-powered social media management platform. Create, schedule, and publish content across Instagram, Facebook, Threads, X, LinkedIn, TikTok, YouTube, Pinterest, Reddit, and Telegram — all from one place.

## Features

- **AI Content Generation** — Connect any OpenAI-compatible or Anthropic-compatible provider (OpenRouter, Groq, Together, etc.)
- **Multi-platform Publishing** — Publish to 10 platforms: nine via OAuth 2.0, Telegram via bot token
- **Smart Composer** — AI adapts tone, length, and format per platform
- **Post Scheduler** — Queue posts with AI-optimized timing
- **Inbox** — Unified notification feed across connected platforms
- **Analytics** — Track engagement across platforms
- **Dark Mode** — Full light/dark theme support

## Tech Stack

- Next.js 16 + React 19
- Tailwind CSS 4 + shadcn/ui
- PostgreSQL (Supabase) + Drizzle ORM
- Zustand (state) + Framer Motion (animations)
- AES-256-GCM encrypted credentials
- JWT auth (jose) with bcrypt

## Getting Started

```bash
# Clone
git clone https://github.com/Hilbras/Hilbras-Studio.git
cd Hilbras-Studio

# Install
pnpm install

# Setup env
cp .env.example .env.local
# Edit .env.local — generate AUTH_SECRET and ENCRYPTION_KEY:
#   openssl rand -hex 32
# Set DATABASE_URL to your Supabase session-pooler connection string,
# then create the tables:
npx drizzle-kit push

# Run
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

See [`.env.example`](.env.example) for the full list. Required:

| Variable | Description |
|----------|-------------|
| `AUTH_SECRET` | JWT signing key (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | AES-256-GCM key for token encryption (`openssl rand -hex 32`). Must be identical in every environment sharing the database |
| `DATABASE_URL` | PostgreSQL (Supabase) session-pooler URL |
| `APP_URL` | Public base URL, used to build OAuth redirect URIs |
| `CRON_SECRET` | Random string authorising the scheduled-post cron endpoint (`openssl rand -hex 32`) |

Platform credentials are configured per-user in the UI (Settings → Accounts) and stored encrypted in the database, or supplied as `{PLATFORM}_CLIENT_ID` / `{PLATFORM}_CLIENT_SECRET` env vars.

### Built-in AI model

Settings → AI Provider always shows a built-in model (**Hilbras AI**) that users can select but can neither edit nor remove. It is configured server-side only:

| Variable | Description |
|----------|-------------|
| `HILBRAS_AI_API_KEY` | API key for the built-in model (falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) |
| `HILBRAS_AI_BASE_URL` | Optional — defaults to `https://api.openai.com/v1` |
| `HILBRAS_AI_API_FORMAT` | Optional — `openai` (default) or `anthropic` |
| `HILBRAS_AI_MODEL_ID` | Optional — defaults to `gpt-4o-mini` (or `claude-sonnet-4-20250514` for Anthropic) |

Users can add their own providers and switch the active model with the **Active model** selector; the built-in one is active until they pick another.

## Scheduled posts

Queued posts are published by `src/lib/scheduled-posts.ts`, triggered by Vercel
Cron (`/api/cron/publish-scheduled`, see `vercel.json`) or by the Scheduler's
**Publish due now** button. Vercel's Hobby plan only allows a cron job to run
**once per day**, so a sub-daily schedule must not be committed there — see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#3-scheduled-posts) for the plan table.

## Deployment

Full walkthrough: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Vercel

1. Push to GitHub
2. Import in [Vercel](https://vercel.com/new)
3. Set environment variables — including `CRON_SECRET`, and the **same**
   `ENCRYPTION_KEY` as any other environment sharing the database
4. Deploy

For platform OAuth, set the redirect URI to:
```
https://your-app.vercel.app/api/connect/{platform}/callback
```

## License

MIT
