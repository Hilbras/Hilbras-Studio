import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI providers",
  description:
    "The built-in Hilbras AI model and your own API keys — how model selection works in Hilbras Studio.",
};

export default function AiProvidersPage() {
  return (
    <article className="docs-prose">
      <h1>AI providers</h1>
      <p className="lede">
        Every AI feature — Composer tools, the Assistant, memory and summaries
        — runs on one <strong>active model</strong> at a time. Choose the
        built-in one or bring your own key.
      </p>

      <h2>Hilbras AI (built-in)</h2>
      <p>
        The <strong>Hilbras AI</strong> row always appears first in{" "}
        <strong>Settings → AI Provider</strong> and works out of the box:
      </p>
      <ul>
        <li>
          Visible everywhere a model can be chosen, but deliberately
          non-editable and non-removable — it&apos;s the guaranteed fallback.
        </li>
        <li>
          Select it like any other option: it has its own radio button, plus{" "}
          <em>Built-in</em> and <em>Active</em> badges and a lock icon.
        </li>
        <li>
          Its endpoint and model are configured on the server (<em>Managed by
          the server</em>) and intentionally never shown in the interface —
          only the name <strong>Hilbras AI</strong> ever appears in the
          Assistant&apos;s model badge.
        </li>
        <li>
          Server-side it uses <code>HILBRAS_AI_API_KEY</code>, falling back to{" "}
          <code>OPENAI_API_KEY</code>/<code>ANTHROPIC_API_KEY</code>, with
          optional <code>HILBRAS_AI_BASE_URL</code>,{" "}
          <code>HILBRAS_AI_API_FORMAT</code>, and{" "}
          <code>HILBRAS_AI_MODEL_ID</code> overrides.
        </li>
      </ul>

      <h2>Add your own provider</h2>
      <p>
        In the same card, add a provider to use your own key — anything
        OpenAI-compatible (OpenRouter, Groq, Together, local runtimes) or
        Anthropic-compatible works:
      </p>
      <ol>
        <li>
          <strong>Name</strong> — anything recognizable (e.g. “My OpenRouter”).
        </li>
        <li>
          <strong>API base URL</strong> — e.g.{" "}
          <code>https://openrouter.ai/api/v1</code>.
        </li>
        <li><strong>API key</strong> — your secret.</li>
        <li>
          <strong>Model ID</strong> — the exact model name the API expects,
          e.g. <code>meta-llama/llama-3.3-70b-instruct</code>.
        </li>
        <li>
          <strong>API format</strong> — OpenAI or Anthropic, matching the
          endpoint.
        </li>
      </ol>
      <p>
        Press <strong>Test</strong> (the ping icon on any row) to verify
        connectivity before relying on it. Keys are encrypted with
        AES-256-GCM, scoped to your account, and never visible to anyone else
        — not even in the page after saving.
      </p>

      <h2>Choosing the active model</h2>
      <ul>
        <li>
          Selection is a <strong>radio</strong> — exactly one option is active
          at a time (the built-in row included).
        </li>
        <li>
          Takes effect on the next AI request: Composer&apos;s Generate /
          Improve / Hashtags, the next Assistant message, and background
          memory/summary work.
        </li>
        <li>
          The Assistant&apos;s badge always reflects the active choice —{" "}
          <strong>Hilbras AI</strong> for the built-in, or{" "}
          <em>provider · model</em> for yours.
        </li>
        <li>
          Delete your active custom provider and selection falls back to the
          built-in <strong>Hilbras AI</strong> automatically — AI never goes
          dark.
        </li>
      </ul>

      <h2>AI preferences</h2>
      <p>
        The same Settings area holds switches saved to your account — hashtag
        behavior, per-platform tone adaptation, scheduling assistance, and
        engagement notifications — independent of which model is active.
      </p>

      <h2>Where the model is used</h2>
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th>What the model does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Composer</td>
            <td>Generate / Improve the post, append hashtags</td>
          </tr>
          <tr>
            <td>Assistant</td>
            <td>Streamed replies grounded in your data</td>
          </tr>
          <tr>
            <td>Memory</td>
            <td>Extract durable facts and summarize old turns</td>
          </tr>
        </tbody>
      </table>
      <div className="callout">
        <p>
          Publishing never depends on the AI provider — platforms are reached
          through their own connections, so a provider outage can&apos;t stop a
          scheduled post.
        </p>
      </div>
    </article>
  );
}
