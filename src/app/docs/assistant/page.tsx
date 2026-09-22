import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Assistant",
  description:
    "Streaming chat with real account context, per-session history, and cross-session long-term memory.",
};

export default function AssistantPage() {
  return (
    <article className="docs-prose">
      <h1>AI Assistant</h1>
      <p className="lede">
        A streaming chat that runs on your real data — not a generic chatbot
        with no idea who you are.
      </p>

      <h2>What it knows</h2>
      <p>Every reply is grounded in three context blocks:</p>
      <ul>
        <li>
          <strong>Your account</strong> — connected platforms, post and
          engagement stats, the weekly chart, recent activity, and today&apos;s
          date.
        </li>
        <li>
          <strong>Long-term memory</strong> — durable facts extracted from your
          past conversations (see below), shared across every session.
        </li>
        <li>
          <strong>This conversation</strong> — your recent turns verbatim, with
          older turns compressed into a summary so context survives long chats.
        </li>
      </ul>
      <p>
        The system prompt also forbids guessing: it never invents follower
        counts, impressions, or dates it wasn&apos;t given — if a metric
        isn&apos;t tracked, it says so plainly and points you to the right page
        (Accounts, Composer, Scheduler, Settings) for configuration questions.
      </p>

      <h2>Sessions</h2>
      <ul>
        <li>
          <strong>New chat</strong> starts a fresh session with a clean
          context.
        </li>
        <li>
          The <strong>recent-chats dropdown</strong> next to it reopens any
          earlier conversation — each session keeps its full message history in
          the database, so you can leave for a week and come back.
        </li>
        <li>
          Memory still crosses sessions: facts learned in one chat are present
          in the next.
        </li>
      </ul>

      <h2>Streaming</h2>
      <p>
        Replies render token by token as the model generates them — no
        spinner-then-wall-of-text wait.
      </p>

      <h2>Long-term memory</h2>
      <p>How it works:</p>
      <ol>
        <li>
          When you send a message of <strong>six words or more</strong>, the
          model scans it for durable facts (&quot;I run a coffee brand&quot;,
          &quot;post twice a week&quot;) — transient chatter is ignored.
        </li>
        <li>
          Up to five facts are captured per message and stored with cross-session
          scope.
        </li>
        <li>
          At most <strong>30 memories</strong> are kept; the oldest are evicted
          as new ones arrive, so the list stays current.
        </li>
        <li>
          Before every reply they&apos;re injected as a{" "}
          <code>&lt;memory&gt;</code> block the model treats as true.
        </li>
      </ol>
      <p>
        You&apos;re always in control: open{" "}
        <strong>Settings → AI → Assistant Memory</strong> to read every stored
        fact and delete any you don&apos;t want kept (&quot;Forget this&quot;).
        Extraction happens quietly alongside your replies — it never interrupts
        the chat.
      </p>

      <h2>The model in use</h2>
      <p>
        A badge shows which model is answering — either{" "}
        <strong>Hilbras AI</strong> (the built-in default) or your own
        provider&apos;s model. Switch any time in{" "}
        <a href="/docs/ai-providers">AI providers</a>; the next message picks
        up the change.
      </p>

      <h2>What to ask</h2>
      <ul>
        <li>&quot;Draft three post ideas for a product launch Friday.&quot;</li>
        <li>&quot;How did this week go?&quot; — it reads your real stats.</li>
        <li>&quot;Rewrite this caption tighter, under 500 characters:&quot;…</li>
        <li>&quot;Plan a posting schedule for next week.&quot;</li>
        <li>
          &quot;What&apos;s the difference between scheduling and Publish due
          now?&quot; — it knows the app.
        </li>
      </ul>
    </article>
  );
}
