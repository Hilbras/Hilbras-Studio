# Hilbras Studio — Roadmap

> One AI → Multiple Social Platforms → One Unified Social Media Management Experience.
> Everything here uses official platform APIs and OAuth. No scraping, no bots, no bypassing.

---

## Status: ✅ Foundation complete

| Layer | State |
|---|---|
| Frontend (Next.js 16 + React 19 + Tailwind 4 + shadcn/ui) | ✅ Landing, pricing, 8 dashboard pages, all animated |
| Auth (JWT sessions, bcrypt, httpOnly cookies, dashboard gate) | ✅ Verified end-to-end in browser |
| Database (SQLite + Drizzle ORM) | ✅ `users`, `social_accounts`, `user_preferences` |
| Token encryption (AES-256-GCM) | ✅ Verified round-trip + tamper detection |
| Platform registry (9 platforms, OAuth endpoints, capabilities) | ✅ Data-only, no drift with UI |
| Username identity (unique handle, login by email OR username) | ✅ Schema + actions + UI |

---

## Phase 1 — OAuth connectors (next)
**Turn `social_accounts` from a stub into real platform connections.**

- [ ] Instagram — Meta OAuth, professional account only, carousel + Reel publishing
- [ ] Facebook — Page publishing (Profile/Page account model)
- [ ] Threads — Meta Graph API, conversational tone rules
- [ ] X — OAuth 2.0 with PKCE, 280-char threads
- [ ] LinkedIn — Member profile + Organization page
- [ ] TikTok — video-only, For You distribution rules
- [ ] YouTube — Channel uploads via Google OAuth
- [ ] Pinterest — Board + Pin, keyword-rich descriptions
- [ ] Reddit — User + Subreddit moderator, per-subreddit rules

Each connector: OAuth flow → encrypted token storage → publish/read API → capability metadata surfaced to the AI.

---

## Phase 2 — AI provider wiring (next)
**Composer and Assistant make real model calls instead of mock responses.**

- [ ] Pick a default provider (OpenAI / Anthropic / Groq / OpenRouter — keys already in `.env.example`)
- [ ] Streaming responses in the Assistant chat
- [ ] Platform-aware content adaptation using the registry's `content.rules` + `maxTextLength`
- [ ] Smart scheduling using `bestTimeToPost` data
- [ ] Reply suggestions in the unified inbox

---

## Phase 3 — Real data behind the dashboard
**Every page currently runs on mock data.**

- [ ] `posts` table + scheduler queue (week calendar becomes live)
- [ ] Engagement metrics from each platform's read APIs (analytics becomes live)
- [ ] Unified inbox reads comments/mentions/DMs across platforms
- [ ] Real follower counts, not mock numbers

---

## Phase 4 — Multi-tenant polish
**The system is single-user today.**

- [ ] Multi-user session handling (already structurally supported)
- [ ] Role-based access (owner vs collaborator)
- [ ] Team approval workflows (Business plan tier)
- [ ] Encrypted secrets at rest verified for all 9 platforms

---

## Out of scope (by design)
- ❌ Scraping, unofficial APIs, account simulation
- ❌ Bypassing platform posting limits or rate limits
- ❌ Fake engagement / automation against platform ToS