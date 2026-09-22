import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Composer",
  description:
    "Write once, adapt per platform — AI rewriting, hashtags, media, publishing and scheduling in Hilbras Studio.",
};

export default function ComposerPage() {
  return (
    <article className="docs-prose">
      <h1>Composer</h1>
      <p className="lede">
        One editor for every platform: write (or let AI write), adapt, add
        media, then publish now or schedule.
      </p>

      <h2>The editor</h2>
      <p>
        The left side is a plain text editor — your draft. Nothing is saved
        until you publish, schedule, or leave it as a draft in the queue.
      </p>

      <h3>Media</h3>
      <ul>
        <li>
          <strong>Upload Image</strong> stores the file on the server (up to
          4&nbsp;MB) and fills the media field for you.
        </li>
        <li>
          Or paste any media URL directly. <code>.mp4</code>/<code>.mov</code>{" "}
          links are sent as video where the platform supports it — otherwise
          as a photo.
        </li>
        <li>
          Media is required for Instagram and Threads media posts; a URL also
          travels with X, LinkedIn, and the rest where accepted.
        </li>
      </ul>

      <h2>AI tools</h2>
      <p>
        Both buttons run on the model you&apos;ve activated in{" "}
        <a href="/docs/ai-providers">Settings</a>:
      </p>
      <ul>
        <li>
          <strong>Generate / Improve Post</strong> — with an{" "}
          <em>empty</em> editor it writes a fresh post from scratch; with text
          already there it rewrites it for the platforms you&apos;ve selected,
          respecting their character limits and content rules. The output is
          always pure post text — no chat preamble, no explanations — and AI
          errors appear on their own error line, never inside your draft where
          they could be published by accident.
        </li>
        <li>
          <strong>Hashtags</strong> — appends a line of 5–8 hashtags matched to
          the post&apos;s topic and language. Needs existing text.
        </li>
      </ul>
      <div className="callout">
        <p>
          The Composer rewrites what you wrote — it won&apos;t invent facts,
          stats, or claims that aren&apos;t in your text.
        </p>
      </div>

      <h2>Target platforms</h2>
      <p>
        The right rail lists your platforms. Only{" "}
        <strong>connected</strong> ones are selectable (unconnected ones show a
        disabled <em>Not connected</em> badge — see{" "}
        <a href="/docs/connecting-accounts">Connecting accounts</a>). The
        selected set drives three things: the AI rewrite&apos;s per-platform
        rules, where publishing goes, and the button&apos;s platform count.
      </p>

      <h2>Publishing</h2>
      <p>
        <strong>Publish to N platforms</strong> sends the post immediately to
        every selected platform and renders a results card: each platform gets
        its own success row (with a <em>View</em> link to the live post) or
        failure row with the exact reason the provider returned. A post counts
        as <em>published</em> if at least one platform accepted it; if every
        platform failed it&apos;s marked <em>failed</em> and stays editable.
      </p>

      <h2>Scheduling</h2>
      <p>
        Flip the <strong>Schedule</strong> switch to reveal date and time
        inputs, then press <strong>Schedule for N platforms</strong>. The post
        is saved with status <em>scheduled</em> and picked up by the{" "}
        <a href="/docs/scheduler">Scheduler</a> when its moment passes.
      </p>

      <h2>Post queue</h2>
      <p>
        The <strong>Queue</strong> toggle in the right rail lists everything
        you&apos;ve written — drafts, scheduled posts, and finished ones — with
        its current status. It refreshes itself after every save, publish, and
        delete, so it doubles as your at-a-glance publishing log.
      </p>

      <h2>Statuses at a glance</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Draft</td>
            <td>Saved but not queued anywhere.</td>
          </tr>
          <tr>
            <td>Scheduled</td>
            <td>Waiting for its date and time on the Scheduler.</td>
          </tr>
          <tr>
            <td>Published</td>
            <td>At least one platform accepted it.</td>
          </tr>
          <tr>
            <td>Failed</td>
            <td>Every selected platform rejected it — reasons in the results.</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
