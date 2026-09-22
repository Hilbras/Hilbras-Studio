import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Getting started",
  description:
    "Create your Hilbras Studio account, connect a platform, and publish your first post.",
};

export default function GettingStartedPage() {
  return (
    <article className="docs-prose">
      <h1>Getting started</h1>
      <p className="lede">
        From an empty account to your first published post — six short steps.
      </p>

      <h2>What Hilbras Studio is</h2>
      <p>
        Hilbras Studio is an AI-powered social media management platform. You
        write in one place and publish everywhere: schedule posts, adapt tone
        per platform, talk to an Assistant that knows your account, and keep
        every credential encrypted on your own account.
      </p>
      <p>Supported publishing platforms:</p>
      <ul>
        <li>
          <strong>OAuth-connected:</strong> Instagram, Facebook, Threads, X,
          LinkedIn, TikTok, YouTube, Pinterest, Reddit
        </li>
        <li>
          <strong>Bot-connected:</strong> Telegram
        </li>
      </ul>

      <h2>1. Create your account</h2>
      <p>
        Sign up with your name, email, username and a password. Passwords are
        stored as bcrypt hashes — they can never be read back. Already have an
        account? Go straight to the{" "}
        <a href="/login">sign-in page</a>.
      </p>

      <h2>2. Connect a social account</h2>
      <p>
        Head to <strong>Accounts</strong> in the sidebar. OAuth platforms each
        need a small developer-app credential set (client ID + secret) that you
        paste once, then press <em>Connect</em> and approve the provider&apos;s
        consent screen. Telegram skips all of that — you paste a bot token and
        a chat, and you&apos;re done.
      </p>
      <div className="callout">
        <p>
          <strong>Shortest path:</strong> connect Telegram first — it needs no
          developer app at all. Full walkthrough in{" "}
          <a href="/docs/connecting-accounts">Connecting accounts</a>.
        </p>
      </div>

      <h2>3. Write your first post</h2>
      <p>
        Open <strong>Composer</strong>. The layout is simple: the editor on the
        left, platform selection and your post queue on the right.
      </p>
      <ul>
        <li>
          Type your post — or press <strong>Generate</strong> with an empty
          editor and let AI write a first draft.
        </li>
        <li>
          With text already in the editor the same button becomes{" "}
          <strong>Improve Post</strong>: a rewrite tuned to the platforms
          you&apos;ve selected, respecting their character limits.
        </li>
        <li>
          <strong>Hashtags</strong> appends a line of 5–8 relevant hashtags.
        </li>
        <li>
          Add media: upload an image (up to 4 MB) or paste any media URL —
          <code>.mp4</code>/<code>.mov</code> links post as video where the
          platform supports it. Instagram and Threads media posts require it.
        </li>
      </ul>

      <h2>4. Publish or schedule</h2>
      <p>
        Select your connected target platforms on the right, then either:
      </p>
      <ul>
        <li>
          <strong>Publish to N platforms</strong> — posts immediately and shows
          a per-platform result (with a link to the live post), or
        </li>
        <li>
          Flip the <strong>Schedule</strong> switch, pick a date and time, and
          press <strong>Schedule for N platforms</strong> — the post waits on
          the <a href="/docs/scheduler">Scheduler</a> until its moment arrives.
        </li>
      </ul>

      <h2>5. Talk to the Assistant</h2>
      <p>
        The <strong>AI Assistant</strong> is a streaming chat that runs on your
        real data — connected accounts, post stats, recent activity — plus
        long-term memory it builds across sessions. Ask it to draft posts,
        explain how the app works, or plan your week. See{" "}
        <a href="/docs/assistant">AI Assistant</a>.
      </p>

      <h2>6. Tune your AI</h2>
      <p>
        <strong>Settings</strong> holds everything AI: pick the active model —
        the built-in <em>Hilbras AI</em> or one of your own providers (see{" "}
        <a href="/docs/ai-providers">AI providers</a>) — set AI preferences,
        review the facts the Assistant remembers, and switch themes.
      </p>

      <h2>Where to go next</h2>
      <ul>
        <li>
          <a href="/docs/connecting-accounts">Connecting accounts</a> — OAuth
          apps and the Telegram bot, step by step.
        </li>
        <li>
          <a href="/docs/composer">Composer</a> — the full writing and
          publishing flow.
        </li>
        <li>
          <a href="/docs/assistant">AI Assistant</a> — sessions, context, and
          memory.
        </li>
      </ul>
    </article>
  );
}
