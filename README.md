# Hilbras Studio

AI-powered social media management platform. Create, schedule, and publish content across Instagram, Facebook, Threads, X, LinkedIn, TikTok, YouTube, Pinterest, and Reddit — all from one place.

## Features

- **AI Content Generation** — Connect any OpenAI-compatible or Anthropic-compatible provider (OpenRouter, Groq, Together, etc.)
- **Multi-platform Publishing** — Publish to 9 platforms with OAuth 2.0 connections
- **Smart Composer** — AI adapts tone, length, and format per platform
- **Post Scheduler** — Queue posts with AI-optimized timing
- **Inbox** — Unified notification feed across connected platforms
- **Analytics** — Track engagement across platforms
- **Dark Mode** — Full light/dark theme support

## Tech Stack

- Next.js 16 + React 19
- Tailwind CSS 4 + shadcn/ui
- SQLite + Drizzle ORM
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
cp .env.local.example .env.local
# Edit .env.local — generate AUTH_SECRET and ENCRYPTION_KEY:
#   openssl rand -hex 32

# Run
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

See [`.env.example`](.env.example) for the full list. Required:

| Variable | Description |
|----------|-------------|
| `AUTH_SECRET` | JWT signing key (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | AES-256-GCM key for token encryption (`openssl rand -hex 32`) |
| `DB_FILE_NAME` | SQLite path (default: `data/hilbras.db`) |

Platform credentials are configured per-user in the UI (Settings → Accounts) and stored encrypted in the database.

## Deployment

### Vercel

1. Push to GitHub
2. Import in [Vercel](https://vercel.com/new)
3. Set environment variables
4. Deploy

For platform OAuth, set the redirect URI to:
```
https://your-app.vercel.app/api/connect/{platform}/callback
```

## License

MIT
