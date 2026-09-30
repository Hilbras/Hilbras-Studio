import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Development guide",
  description:
    "Stack, project structure, environment variables, database, cron, and deployment — building on Hilbras Studio.",
};

export default function DeveloperDocsPage() {
  return (
    <article className="docs-prose">
      <h1>Development guide</h1>
      <p className="lede">
        Technical documentation for working on Hilbras Studio itself — stack,
        setup, configuration, and how the pieces fit.
      </p>

      <h2>Tech stack</h2>
      <ul>
        <li>
          <strong>Next.js 16</strong> (App Router) + <strong>React 19</strong>{" "}
          — server components, server actions, route handlers
        </li>
        <li>
          <strong>Tailwind CSS 4</strong> + shadcn/ui-style components on
          design tokens (<code>--gold-*</code> accent, light/dark via CSS
          variables)
        </li>
        <li>
          <strong>PostgreSQL</strong> (Supabase) +{" "}
          <strong>Drizzle ORM</strong>
        </li>
        <li>
          Auth: JWT sessions (<code>jose</code>, HS256) +{" "}
          <code>bcrypt</code> password hashes
        </li>
        <li>
          Credentials: AES-256-GCM encryption with a master{" "}
          <code>ENCRYPTION_KEY</code>
        </li>
        <li>
          Zustand (state), Framer Motion (animation), Recharts (charts)
        </li>
      </ul>

      <h2>Project structure</h2>
      <pre>
        <code>{`src/
├─ app/
│  ├─ (auth)/          login, signup
│  ├─ (dashboard)/     dashboard, assistant, accounts, composer,
│  │                    scheduler, inbox, analytics, settings
│  ├─ api/             assistant (SSE stream), cron/publish-scheduled,
│  │                    connect/[platform]/{authorize,callback},
│  │                    media, webhooks
│  ├─ actions/         server actions (posts, publish, ai, chat, …)
│  ├─ docs/, pricing/, privacy/   public pages
│  └─ layout.tsx, globals.css
├─ components/         UI primitives, sidebar, feature components
├─ lib/                platforms.ts (registry), publish.ts (publishers),
│                      ai.ts (model resolution), scheduled-posts.ts,
│                      chat.ts, crypto
│  ├─ ai/              planner.ts, compose.ts, complete.ts (the one
│  │                   model-call boundary), limits.ts (per-run spend),
│  │                   context.ts (what crosses into model output)
│  ├─ runtime/         execution state, plan gate, run store,
│  │                   tools.ts (the tool registry), references.ts ($ref
│  │                   resolution), planning.ts, local-tools.ts,
│  │                   inngest/ (queue functions)
│  └─ goals/           cron.ts, validation.ts, parse.ts,
│                      service.ts, scheduler.ts
├─ db/schema.ts        Drizzle schema
drizzle/               generated SQL migrations
vercel.json            cron schedule`}</code>
      </pre>

      <h2>Local development</h2>
      <pre>
        <code>{`pnpm install
cp .env.example .env.local      # then fill it in
npx drizzle-kit push            # sync schema to your database
pnpm dev                        # http://localhost:3000`}</code>
      </pre>
      <p>
        Generate the two secrets with <code>openssl rand -hex 32</code> —{" "}
        <code>AUTH_SECRET</code> (session signing) and{" "}
        <code>ENCRYPTION_KEY</code> (token encryption). Scripts:{" "}
        <code>pnpm dev</code>, <code>pnpm build</code>,{" "}
        <code>pnpm start</code>, <code>pnpm lint</code>.
      </p>

      <h2>Environment variables</h2>
      <p>
        Full annotated template in <code>.env.example</code>. Core:
      </p>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>AUTH_SECRET</code></td>
            <td>HS256 key for session JWTs</td>
          </tr>
          <tr>
            <td><code>ENCRYPTION_KEY</code></td>
            <td>
              AES-256-GCM master key for stored tokens — must be identical in
              every environment sharing the DB, and rotating it invalidates
              all tokens
            </td>
          </tr>
          <tr>
            <td><code>DATABASE_URL</code></td>
            <td>Postgres — use Supabase&apos;s Session-mode pooler URL</td>
          </tr>
          <tr>
            <td><code>APP_URL</code></td>
            <td>
              Public origin; OAuth redirect URIs are{" "}
              <code>{`{APP_URL}/api/connect/{platform}/callback`}</code>
            </td>
          </tr>
          <tr>
            <td><code>CRON_SECRET</code></td>
            <td>Bearer token guarding the scheduled-publish endpoint</td>
          </tr>
        </tbody>
      </table>
      <p>Optional integrations:</p>
      <ul>
        <li>
          <strong>AI:</strong> <code>HILBRAS_AI_API_KEY</code> (+{" "}
          <code>HILBRAS_AI_BASE_URL</code>, <code>HILBRAS_AI_API_FORMAT</code>
          , <code>HILBRAS_AI_MODEL_ID</code>) powers the built-in model; falls
          back to <code>OPENAI_API_KEY</code>/<code>ANTHROPIC_API_KEY</code>.{" "}
          Per-user and deployment-wide request budgets are configured with{" "}
          <code>ASSISTANT_RATE_LIMIT</code>, <code>AI_COMPOSER_RATE_LIMIT</code>,{" "}
          <code>AI_INBOX_RATE_LIMIT</code>, <code>AI_PROVIDER_TEST_RATE_LIMIT</code>,{" "}
          <code>AI_MEMORY_RATE_LIMIT</code>, <code>AI_SUMMARY_RATE_LIMIT</code>, and{" "}
          <code>AI_GLOBAL_RATE_LIMIT</code>.
        </li>
        <li>
          <strong>Platform apps:</strong>{" "}
          <code>{`{PLATFORM}_CLIENT_ID`}</code> /{" "}
          <code>{`{PLATFORM}_CLIENT_SECRET`}</code> — e.g.{" "}
          <code>X_CLIENT_ID</code>, <code>THREADS_CLIENT_ID</code> (Threads
          pair), <code>GOOGLE_CLIENT_ID</code> (YouTube),{" "}
          <code>TIKTOK_CLIENT_KEY</code>. A platform shows as not-configured
          until both exist.
        </li>
      </ul>

      <h2>Database &amp; migrations</h2>
      <ul>
        <li>
          Schema lives in <code>src/db/schema.ts</code>;{" "}
          <code>npx drizzle-kit push</code> syncs it directly (fast path for
          development).
        </li>
        <li>
          For explicit migrations: <code>npx drizzle-kit generate</code> writes
          SQL into <code>drizzle/</code>; apply it to Supabase (SQL editor or{" "}
          <code>drizzle-kit migrate</code>).
        </li>
        <li>
          Connect with the <strong>Session mode pooler</strong> URL — serverless
          functions (Vercel) exhaust the direct connection limit quickly.
        </li>
      </ul>

      <h2>Scheduled publishing</h2>
      <ul>
        <li>
          <code>vercel.json</code> declares one cron:{" "}
          <code>0 9 * * *</code> → <code>GET /api/cron/publish-scheduled</code>
          .
        </li>
        <li>
          The route expects{" "}
          <code>Authorization: Bearer $CRON_SECRET</code> (Vercel sends it
          automatically once <code>CRON_SECRET</code> is set) and publishes
          every due post, catching up on missed runs.
        </li>
        <li>
          The Scheduler page&apos;s <strong>Publish due now</strong> button
          invokes the same logic manually — required on Vercel&apos;s Hobby
          plan, where cron runs at most daily.
        </li>
        <li>
          <strong>Goals are scheduled separately.</strong> The post scheduler
          above runs on Vercel cron; the goal scheduler is an Inngest cron
          function (<code>*/5 * * * *</code>) in{" "}
          <code>src/lib/runtime/inngest/functions.ts</code>, because the queue is
          already the system that owns execution. It finds goals whose{" "}
          <code>next_firing_at</code> has passed and sends one{" "}
          <code>GOAL_SCHEDULED</code> event each.
        </li>
        <li>
          <strong>Goal runs need a configured AI provider.</strong> A run plans
          with the user&apos;s provider, so a goal with no provider fails with{" "}
          <code>ai_unavailable</code> rather than publishing nothing quietly.
          Every model call a run makes goes through one boundary —{" "}
          <code>createCompleter</code> in <code>src/lib/ai/complete.ts</code> —
          which charges the run&apos;s in-memory meter first, then the window
          budget, then resolves the provider. New model call sites inside the
          Runtime must go through it.
        </li>
        <li>
          <strong>Approvals.</strong> A step whose tool has{" "}
          <code>sideEffect: true</code> in <code>src/lib/runtime/tools.ts</code>{" "}
          consults the user&apos;s execution policy
          (<code>auto</code> | <code>approval</code> | <code>disabled</code>) via
          a gate built once per run in{" "}
          <code>src/lib/runtime/approval-store.ts</code>. The gate is a{" "}
          <strong>required</strong> field of <code>ExecutorDeps</code> with no
          default, so a call site cannot forget it. On{" "}
          <code>approval</code> the run suspends in the database and the
          invocation returns normally; a decision or the 24h window closing wakes{" "}
          <code>resume-goal-run</code>, and a five-minute sweep closes overdue
          approvals and re-sends any decision the queue missed.
        </li>
        <li>
          <strong>A new side-effecting tool is approvable automatically.</strong>{" "}
          It needs no policy work: set <code>sideEffect: true</code> on the{" "}
          <code>ToolSpec</code> and mark any field a human may change with{" "}
          <code>editable: true</code>. A policy naming a tool without a side
          effect is refused at write time rather than accepted and ignored.
        </li>
      </ul>

      <h2>Deployment</h2>
      <ul>
        <li>
          Import the repo into Vercel; set every env var — with{" "}
          <strong>the same</strong> <code>AUTH_SECRET</code>,{" "}
          <code>ENCRYPTION_KEY</code>, and <code>DATABASE_URL</code> as any
          other environment sharing the database.
        </li>
        <li>
          Set <code>APP_URL</code> to the exact production origin (no trailing
          slash), and register the matching callback URIs in each
          platform&apos;s developer portal.
        </li>
        <li>
          Pushing to <code>main</code> auto-deploys. More detail in{" "}
          <a
            href="https://github.com/Hilbras/Hilbras-Studio/blob/main/docs/DEPLOYMENT.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            docs/DEPLOYMENT.md
          </a>{" "}
          in the repository.
        </li>
      </ul>

      <h2>Adding a platform</h2>
      <ol>
        <li>
          <strong>Registry</strong> — add an entry to{" "}
          <code>PLATFORM_REGISTRY</code> in <code>src/lib/platforms.ts</code>:
          id, name, <code>connection: &quot;oauth&quot; | &quot;manual&quot;</code>,
          optional OAuth <code>auth</code> block, character limit
          (<code>maxTextLength</code>), and content rules. Add the matching
          <code>PUBLISHING_CAPABILITIES</code> entry; connection support and
          publishing support are separate.
        </li>
        <li>
          <strong>Icon &amp; color</strong> — SVG + brand color in{" "}
          <code>components/platform-icon.tsx</code>, and the analytics chart
          color in <code>lib/dashboard/queries.ts</code>.
        </li>
        <li>
          <strong>Publisher</strong> — write <code>publishToX</code>-style
          function in <code>src/lib/publish.ts</code> and add its dispatcher
          case.
        </li>
        <li>
          <strong>Connection</strong> — OAuth platforms work off the{" "}
          <code>auth</code> block + env credentials through the existing{" "}
          <code>authorize</code>/<code>callback</code> routes; manual platforms
          (like Telegram) get a dedicated server action that validates
          credentials and stores them in <code>social_accounts</code>.
        </li>
        <li>
          <strong>Guards</strong> — anything gated on a live connection goes
          through the connection helpers and the capability matrix, so the UI
          can distinguish Connected from Connect-only and only enables a
          publishable target in Composer.
        </li>
      </ol>
      <div className="callout">
        <p>
          The Telegram integration is the reference implementation of a{" "}
          <strong>manual</strong> platform — registry entry, validation action,
          publisher, and UI guards, with no migration required.
        </p>
      </div>
    </article>
  );
}
