import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Approvals",
  description:
    "Approve, reject, or edit posts the AI planned before they publish — and how the 24-hour window works.",
};

export default function ApprovalsPage() {
  return (
    <article className="docs-prose">
      <h1>Approvals</h1>
      <p className="lede">
        Posts the Runtime planned and is holding until you say go ahead.
      </p>

      <h2>What an approval shows you</h2>
      <ul>
        <li>
          <strong>The post itself</strong> — the exact text that will publish.
          Not a summary of it, and not the earlier draft it came from.
        </li>
        <li>
          <strong>Where it will go</strong> — the target account.
        </li>
        <li>
          <strong>How long you have</strong> — a countdown, oldest deadline
          first.
        </li>
      </ul>

      <h2>The three answers</h2>
      <ol>
        <li>
          <strong>Approve</strong> — the run resumes and publishes.
        </li>
        <li>
          <strong>Reject</strong> — this step is skipped and the rest of the run
          continues.
        </li>
        <li>
          <strong>Edit, then approve</strong> — change the text before it goes
          out.
        </li>
      </ol>
      <div className="callout">
        <p>
          <strong>Rejecting one post does not cancel the run.</strong> It skips
          that step and the remaining steps carry on. Only cancelling a run ends
          the whole thing — and cancelling is not something an approval does.
        </p>
      </div>

      <h2>Editing before you approve</h2>
      <p>
        You can change what a post says. What is editable depends on the step
        being approved, and the screen shows only the fields that are — for
        publishing, that is the text.
      </p>
      <p>Your edit is checked before it is accepted, not after:</p>
      <ul>
        <li>
          A length limit is enforced, and exceeding it is refused with the
          reason rather than silently truncated.
        </li>
        <li>
          You cannot add a media URL by editing text. That would be granting a
          new capability, not editing a post, and the two are deliberately not
          the same action.
        </li>
      </ul>
      <p>
        The card reports exactly what the server did. If an edit was refused, you
        are told which rule refused it — the screen does not decide the outcome
        and show you a hopeful message.
      </p>

      <h2>The 24-hour window</h2>
      <p>
        Each question stays open for <strong>24 hours</strong>. If nobody
        answers, the step fails and the run moves on.
      </p>
      <div className="callout">
        <p>
          <strong>A timeout fails. It never approves.</strong> Publishing
          something because you were asleep is the exact opposite of what
          &ldquo;ask me first&rdquo; asks for. The{" "}
          <a href="/docs/runtime">Runtime</a> also counts questions whose time
          has run out but which have not been marked yet, so a question about to
          fail is never reported as zero.
        </p>
      </div>
      <p>
        The countdown is advisory; the deadline is authoritative. If the clock on
        your machine disagrees with ours, the server decides — the window closes
        at the stated moment either way, and the countdown agrees with it to the
        millisecond.
      </p>

      <h2>Not everything asks</h2>
      <p>
        Whether a step stops for approval at all is a{" "}
        <a href="/docs/policies">policy</a> decision. You can let publishing run
        automatically, ask every time, or refuse it outright — per tool and per
        account.
      </p>

      <h2>One run, several questions</h2>
      <p>
        A run can stop more than once. Approving a post resumes that run, which
        may reach the next step that needs you. The{" "}
        <a href="/docs/runtime">run log</a> shows every decision made on it, in
        order, with the run&rsquo;s full event trail.
      </p>
    </article>
  );
}
