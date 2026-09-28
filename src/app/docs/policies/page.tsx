import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Execution policies",
  description:
    "Decide whether Hilbras Studio publishes automatically, asks first, or never — per tool and per account.",
};

export default function PoliciesPage() {
  return (
    <article className="docs-prose">
      <h1>Execution policies</h1>
      <p className="lede">
        For anything that changes the world — publishing a post — you decide
        whether the Runtime just does it, asks you first, or never does it at
        all.
      </p>

      <h2>The three settings</h2>
      <ol>
        <li>
          <strong>Automatic</strong> — the Runtime does it without asking. This
          is the default for everything.
        </li>
        <li>
          <strong>Ask first</strong> — it stops and waits for you on{" "}
          <a href="/docs/approvals">Approvals</a>.
        </li>
        <li>
          <strong>Never</strong> — it does not happen. The step fails and the run
          continues; it is not silently skipped.
        </li>
      </ol>

      <h2>Where a policy applies</h2>
      <p>
        Policies can be set two ways, and both are on the same screen:
      </p>
      <ul>
        <li>
          <strong>Per account</strong> — &ldquo;never post to this account
          without me&rdquo;. Useful for an account you want watched more closely
          than the rest.
        </li>
        <li>
          <strong>Per tool</strong> — &ldquo;always ask before publishing&rdquo;,
          regardless of which account.
        </li>
      </ul>
      <p>
        Only tools that actually change something appear here. Writing a post is
        internal — there is nothing to consent to — so it is not on this page,
        and there is no dead switch pretending otherwise.
      </p>

      <h2>How a policy is read</h2>
      <p>
        A policy is a <strong>standing instruction about a target</strong>, and
        it is consulted immediately before the step runs — not at the start of the
        run, and not from a copy made when the run was planned. Change a policy
        while a run is suspended and the next step to execute answers to the new
        setting.
      </p>
      <p>
        &ldquo;Never&rdquo; is stronger than &ldquo;ask first&rdquo;: a step
        refused by policy does not reach you as a question. You chose never; being
        asked anyway would make it a suggestion.
      </p>

      <h2>What a policy does not change</h2>
      <ul>
        <li>
          It does not change what is written. An edit you make at an approval
          screen is still validated against the same limits.
        </li>
        <li>
          It does not apply to the <a href="/docs/composer">Composer</a>. Posts
          you write and send yourself are not the Runtime acting on your behalf,
          so no policy stands between you and your own post.
        </li>
        <li>
          It does not resurrect a past decision. A window that has already closed
          is closed.
        </li>
      </ul>

      <h2>Changing your mind</h2>
      <p>
        Policies are stored per account and per tool, and the{" "}
        <a href="/docs/runtime">Runtime</a> reads them live, so a change takes
        effect on the next step to run. If a run is already waiting on a question
        you no longer want asked, answering it — or letting the window close — is
        how you deal with that one; the policy applies going forward.
      </p>
    </article>
  );
}
