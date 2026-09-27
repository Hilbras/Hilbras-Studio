# Hilbras Studio

**A Goal-Driven AI Runtime.** You describe what you want to accomplish; the
Runtime plans and executes it using AI, tools, platform connections, accounts,
schedules, and human approvals.

> "Every day at 10 AM, publish two AI-related posts on the Hilbras X and
> Instagram accounts."

---

## Status

The product is being rebuilt from a social media management tool into a
Goal-Driven AI Runtime. Releases follow a phase-by-phase plan from **v0.1.0** to
**v1.0.0**.

| Version | Release |
|---|---|
| v0.1.0 | Platform connections, AI Composer, scheduler, Assistant |
| v0.2.0 | Architecture Foundation |
| v0.3.0 | Runtime Foundation |
| v0.4.0 | Multi-Account Connections |
| **v0.5.0** | Unified Platform API — targets |
| v0.5.1 | Unified Platform API: connectors |
| v0.6.0 | Goal Engine |
| v0.7.0 | AI Planning |
| **v0.8.0** | **Current — Human-in-the-Loop** |
| v0.9.0 | Studio 2.0 |
| v0.9.5 | Release Candidate |
| **v1.0.0** | **Goal-Driven AI Runtime** |

See [`ROADMAP.md`](ROADMAP.md) for the full plan and
[`docs/architecture.md`](docs/architecture.md) for the layer contracts and
architecture decisions. [`CHANGELOG.md`](CHANGELOG.md) records every release.

## Today's capabilities (v0.8.0)

- **AI Content Generation** — Connect any OpenAI-compatible or Anthropic-compatible
  provider (OpenRouter, Groq, Together, etc.), or use the built-in Hilbras AI model.
- **Multi-platform Publishing** — Instagram, Facebook, Threads, X, and Telegram
  publish today. LinkedIn, TikTok, YouTube, Pinterest, and Reddit complete OAuth
  but have no publisher yet.
- **Smart Composer** — AI rewrites content with the selected platforms' limits in view.
- **Post Scheduler** — Queue posts for scheduled publishing.
- **Goal Engine** — Goals with cron schedules in the user's own time zone,
  daylight-saving handling, validation against connected accounts, and
  pause/resume. A scheduler fires them.
- **AI Planning** — A fired goal is turned into an execution plan by the model.
  A tool registry decides what a step may invoke, the plan is gated against the
  goal's own target accounts before anything runs, and each post is written at
  execution time rather than frozen at planning time, so a daily goal does not
  publish the same words daily.
- **Human-in-the-Loop** — A side effect can require a person to approve it
  first. Set a policy per account or per tool to `auto`, `approval`, or
  `disabled`; an `approval` policy suspends the run mid-plan and the question
  holds the real post text, so the person sees what will be published and may
  edit it. Approve, reject, or let the 24-hour window close — all three let the
  run continue to its other accounts rather than abandoning them. Unanswered
  approvals expire; a decision that fails to reach the queue is picked up by a
  sweep, so a suspension is never lost. The interface for setting policies and
  answering questions is the next phase; the system behind it ships now.
- **Inbox** — X mentions and Instagram conversations.
- **Assistant** — Streaming chat with persistent sessions and long-term memory.
- **Analytics** — Publishing outcomes and weekly activity.
- **Dark Mode** — Full light/dark theme support.

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
