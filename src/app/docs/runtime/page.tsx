import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Runtime",
  description:
    "The Runtime dashboard in Hilbras Studio — what your goals are doing, what is waiting on you, and what went wrong.",
};

export default function RuntimePage() {
  return (
    <article className="docs-prose">
      <h1>Runtime</h1>
      <p className="lede">
        The Runtime is where a goal becomes work. This page is the answer to
        &ldquo;is it running, is it stuck, and does it need me?&rdquo;
      </p>

      <h2>What&apos;s on the page</h2>
      <ul>
        <li>
          <strong>Four numbers</strong> — active goals, runs in flight, failures
          this week, and connected accounts.
        </li>
        <li>
          <strong>What&apos;s waiting on you</strong> — every approval the
          Runtime is holding, oldest deadline first. See{" "}
          <a href="/docs/approvals">Approvals</a>.
        </li>
        <li>
          <strong>Recent runs</strong> — the last few firings, newest first.
          Each links to its own run log.
        </li>
      </ul>
      <p>
        <Link href="/goals">Goals</Link> is the full list;{" "}
        <Link href="/runtime/runs">Runs</Link> is the full history.
      </p>

      <h2>Reading the numbers</h2>
      <h3>In flight</h3>
      <p>
        Runs that are <em>claimed or executing right now</em>. A run waiting for
        your approval is deliberately <strong>not</strong> counted here — it is
        not doing anything, it is holding a question, and it is counted on its
        own instead. A dashboard that told you &ldquo;2 in flight&rdquo; when one
        of them was waiting on you would be sending you to the wrong screen.
      </p>

      <h3>Failed this week</h3>
      <p>
        Runs that ended in failure in the last seven days. It is a seven-day
        window on purpose: a count of all failures ever is a number that only
        goes up and tells you nothing about whether the system is healthy now.
      </p>

      <h3>Goals that will not fire</h3>
      <div className="callout">
        <p>
          <strong>The quietest failure mode.</strong> If a goal targets an
          account that is switched off, disconnected, or no longer able to
          publish, nothing errors and no run is ever created — the goal just
          quietly does nothing, forever. This page counts those goals explicitly.
          If this number is above zero, the fix is on{" "}
          <a href="/docs/connecting-accounts">Accounts</a>.
        </p>
      </div>
      <p>
        A goal that is <strong>paused</strong> is not counted here. A paused goal
        not firing is the reason you paused it.
      </p>

      <h2>From a number to the cause</h2>
      <p>
        Every run links to a <a href="/docs/approvals">run log</a> showing the
        plan it was given, each step in order, the exact input and output, and a
        timestamped event trail. The short failure reason shown in a list is the
        same one recorded on the run, so what you read here is what the log will
        tell you — not a summary written by the screen.
      </p>

      <h2>Where to go next</h2>
      <ul>
        <li>
          Nothing is scheduled — <Link href="/goals/new">create a goal</Link>.
        </li>
        <li>
          Something is waiting — the <a href="/approvals">Approvals</a> screen.
        </li>
        <li>
          A goal is quiet — check its{" "}
          <a href="/docs/connecting-accounts">accounts</a> and its{" "}
          <a href="/docs/policies">policies</a>.
        </li>
      </ul>
    </article>
  );
}
