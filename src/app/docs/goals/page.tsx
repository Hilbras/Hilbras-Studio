import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Goals",
  description:
    "Create and configure recurring goals in Hilbras Studio — statement, schedule, timezone, and target accounts.",
};

export default function GoalsPage() {
  return (
    <article className="docs-prose">
      <h1>Goals</h1>
      <p className="lede">
        A goal is the thing you actually set up: what to publish, where, and how
        often. Everything else — planning, writing, publishing, asking you first
        — happens because of a goal.
      </p>

      <h2>What a goal is made of</h2>
      <ol>
        <li>
          <strong>What should this goal do?</strong> A plain-language statement.
          This is the text the AI planner reads, so &ldquo;share what shipped this
          week in under a paragraph&rdquo; works better than &ldquo;weekly
          update&rdquo;.
        </li>
        <li>
          <strong>Where should it go?</strong> One or more connected accounts.
        </li>
        <li>
          <strong>When should it run?</strong> A cron schedule and a timezone.
        </li>
      </ol>
      <p>
        The title is just a label for the list. The statement is the part that
        matters.
      </p>

      <h2>Schedules and timezones</h2>
      <p>
        Schedules are written in the timezone you choose, not in UTC —{" "}
        <code>0 9 * * *</code> with <strong>Europe/Berlin</strong> means 09:00
        Berlin, and it stays 09:00 Berlin across a daylight-saving change.
      </p>
      <p>Each goal shows the exact moment it will next fire, in your own timezone.</p>
      <div className="callout">
        <p>
          <strong>A goal is checked before it is saved.</strong> If the schedule
          can never fire, or a target account is switched off or cannot publish,
          you are told which one and why — rather than saving a goal that would
          quietly do nothing.
        </p>
      </div>
      <p>
        A paused goal is not checked, because a paused goal is not meant to fire.
        It keeps no firing time at all, so it cannot be picked up by accident.
      </p>

      <h2>Statuses</h2>
      <ol>
        <li>
          <strong>Active</strong> — in the schedule, will fire.
        </li>
        <li>
          <strong>Paused</strong> — kept, not in the schedule. Resuming starts
          again from now; it does not replay missed firings.
        </li>
        <li>
          <strong>Archived</strong> — finished. History is kept.
        </li>
      </ol>
      <p>
        Paused and archived goals keep their runs, so the{" "}
        <a href="/docs/runtime">Runtime</a> can still tell you how they behaved.
      </p>

      <h2>A goal&apos;s page</h2>
      <p>Opening a goal shows:</p>
      <ul>
        <li>
          <strong>Configuration</strong> — everything above, editable. Saved
          changes take effect from the next firing; a run already in progress
          finishes with the configuration it started with.
        </li>
        <li>
          <strong>Last run</strong> — worked, failed, or not run yet, with the
          reason if it failed.
        </li>
        <li>
          <strong>Firing history and every run this goal has made</strong>,
          newest first. Each run opens its own log.
        </li>
      </ul>
      <p>
        If a target is unusable, the goal page says so on the account itself
        rather than leaving you to work it out from a silent goal.
      </p>

      <h2>What firing actually does</h2>
      <p>
        Each firing creates a <a href="/docs/runtime">run</a>. The run asks the AI
        planner for a plan, executes the plan&rsquo;s steps in order, and stops
        for your approval before anything that publishes — unless a{" "}
        <a href="/docs/policies">policy</a> says otherwise.
      </p>
      <p>
        Editing the statement changes the plan for the <em>next</em> run. There
        is no retroactive rewriting of runs that already happened.
      </p>
    </article>
  );
}
