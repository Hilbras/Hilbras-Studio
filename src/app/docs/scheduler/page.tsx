import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scheduler",
  description:
    "How scheduled posts run in Hilbras Studio — cron, catch-up, and manual publishing.",
};

export default function SchedulerPage() {
  return (
    <article className="docs-prose">
      <h1>Scheduler</h1>
      <p className="lede">
        Everything you schedule lives here until its moment arrives — then a
        background cron publishes it, or you trigger it yourself.
      </p>

      <h2>What&apos;s on the page</h2>
      <ul>
        <li>
          Your scheduled posts — content preview, target platforms, and the
          exact moment they&apos;re due.
        </li>
        <li>
          <strong>New post</strong> — jumps to the{" "}
          <a href="/docs/composer">Composer</a> to queue another one.
        </li>
        <li>
          <strong>Publish due now</strong> — manual trigger described below.
        </li>
      </ul>

      <h2>How scheduled posts run</h2>
      <p>
        Scheduling stores an exact moment in time. A cron job calls{" "}
        <code>/api/cron/publish-scheduled</code> daily at{" "}
        <strong>09:00&nbsp;UTC</strong>, and that endpoint publishes every post
        whose moment has passed — including anything overdue from a run that
        was missed, so late posts still go out instead of silently expiring.
      </p>
      <div className="callout">
        <p>
          <strong>Vercel Hobby plan:</strong> cron jobs run at most once per
          day. For same-day precision, schedule the post and press{" "}
          <strong>Publish due now</strong> when you want it live — or run more
          frequent crons on a paid plan.
        </p>
      </div>

      <h2>Publish due now</h2>
      <p>
        The manual catch-up button: it publishes everything due at this second
        (overdue included) and reports how many posts were published versus
        failed. It&apos;s the same code path the cron runs, so it&apos;s also
        the honest way to test a scheduled post without waiting for the clock.
      </p>

      <h2>Statuses</h2>
      <ol>
        <li>
          <strong>Scheduled</strong> — waiting on the queue with a set time.
        </li>
        <li>
          <strong>Published</strong> — at least one selected platform accepted
          it; per-platform links and IDs are recorded.
        </li>
        <li>
          <strong>Failed</strong> — every selected platform rejected it. The
          per-platform reasons are kept, so you can fix the account or content
          and post again.
        </li>
      </ol>
      <p>
        Drafts (no time set) never run — schedule them from the Composer when
        you&apos;re ready.
      </p>

      <h2>Tips</h2>
      <ul>
        <li>
          Queue several posts at once and let the daily cron batch them — or
          press <strong>Publish due now</strong> to release them one by one as
          you review.
        </li>
        <li>
          A failed platform doesn&apos;t undo the others — check the results
          card in the <a href="/docs/composer">Composer</a> queue to see which
          one needs attention (usually a reconnect on{" "}
          <a href="/docs/connecting-accounts">Accounts</a>).
        </li>
        <li>
          Deleting a scheduled post from the queue removes it before the cron
          ever sees it.
        </li>
      </ul>
    </article>
  );
}
