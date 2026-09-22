import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connecting accounts",
  description:
    "Connect social accounts to Hilbras Studio — OAuth developer apps for nine platforms, and a bot token for Telegram.",
};

export default function ConnectingAccountsPage() {
  return (
    <article className="docs-prose">
      <h1>Connecting accounts</h1>
      <p className="lede">
        There are two ways to connect: OAuth consent for nine platforms, and a
        bot token for Telegram. Both live on the <strong>Accounts</strong>{" "}
        page.
      </p>

      <h2>OAuth platforms</h2>
      <p>
        Each OAuth platform needs a free developer app — a one-time setup that
        gives you a <em>client ID</em> and <em>client secret</em>. Create one in
        the platform&apos;s developer portal:
      </p>
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th>Where to create the app</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Instagram</td>
            <td>developers.facebook.com → Instagram API with Instagram Login</td>
          </tr>
          <tr>
            <td>Facebook</td>
            <td>developers.facebook.com → Facebook Login</td>
          </tr>
          <tr>
            <td>Threads</td>
            <td>
              developers.facebook.com → app with the “Access the Threads API”
              use case — use the <strong>Threads</strong> app ID/secret pair
              (App Dashboard → Settings), not the Instagram pair
            </td>
          </tr>
          <tr>
            <td>X</td>
            <td>developer.x.com — OAuth 2.0 with PKCE</td>
          </tr>
          <tr>
            <td>LinkedIn</td>
            <td>developer.linkedin.com</td>
          </tr>
          <tr>
            <td>TikTok</td>
            <td>developers.tiktok.com</td>
          </tr>
          <tr>
            <td>YouTube</td>
            <td>Google Cloud Console → enable YouTube Data API v3</td>
          </tr>
          <tr>
            <td>Pinterest</td>
            <td>developers.pinterest.com</td>
          </tr>
          <tr>
            <td>Reddit</td>
            <td>reddit.com/prefs/apps</td>
          </tr>
        </tbody>
      </table>

      <h2>Connect steps (OAuth)</h2>
      <ol>
        <li>
          Create the app in the platform&apos;s portal and add this redirect
          URI <strong>exactly</strong> (your real origin instead of the
          example host):
          <pre>
            <code>https://your-domain.com/api/connect/{`{platform}`}/callback</code>
          </pre>
          On this deployment that&apos;s{" "}
          <code>https://hilbras-studio.vercel.app/api/connect/{`{platform}`}/callback</code>
          ; locally it&apos;s <code>http://localhost:3000/…</code> — the origin
          is whatever <code>APP_URL</code> is set to.
        </li>
        <li>
          In Hilbras Studio, open <strong>Accounts</strong> → the platform →{" "}
          <strong>Config</strong>, paste the credentials, and save. (Or set the{" "}
          <code>*_CLIENT_ID</code>/<code>*_CLIENT_SECRET</code> env vars on the
          server — a platform shows <em>Configured</em> as soon as both exist.)
        </li>
        <li>
          Press <strong>Connect</strong> — you&apos;re sent to the platform to
          approve access, then returned to Accounts with a{" "}
          <strong>Connected</strong> badge.
        </li>
      </ol>

      <div className="callout">
        <p>
          <strong>Threads pitfall:</strong> a Threads app carries two credential
          pairs (Instagram/Facebook <em>and</em> Threads). Always paste the
          <strong> Threads</strong> pair — the Instagram one fails token
          exchange with HTTP 400.
        </p>
      </div>

      <h2>Where credentials live</h2>
      <ul>
        <li>
          Credentials you paste in the UI are encrypted with AES-256-GCM and
          scoped to your account — no other user can read them.
        </li>
        <li>
          Env-var credentials belong to whoever runs the deployment and act as
          a server-wide default.
        </li>
        <li>
          Platform access tokens (the OAuth results) are encrypted the same
          way. Rotating <code>ENCRYPTION_KEY</code> invalidates every stored
          token — never do it casually, and keep the key identical across all
          environments sharing one database.
        </li>
      </ul>

      <h2>Status badges</h2>
      <ul>
        <li>
          <strong>Configured</strong> — credentials are present, but the
          platform isn&apos;t linked yet. Press Connect.
        </li>
        <li>
          <strong>Connected</strong> — live link; publishing works.
        </li>
        <li>
          <strong>Permissions / session warnings</strong> — the provider
          revoked something or the token expired. Press{" "}
          <strong>Reconnect</strong> (a fresh OAuth round-trip) to repair it.
        </li>
        <li>
          <strong>Disconnect</strong> drops the stored access token; your
          saved credentials stay, so Connect works again immediately.
        </li>
      </ul>

      <h2>Telegram (bot connection)</h2>
      <p>
        Telegram has no OAuth — you connect a bot that can post into a channel
        or group you control.
      </p>
      <ol>
        <li>
          In Telegram, open <strong>@BotFather</strong> → <code>/newbot</code>,
          pick a display name and username, and copy the{" "}
          <strong>token</strong> it gives you.
        </li>
        <li>
          Add the bot to your target <strong>channel or group</strong>. For a
          channel, make it an <strong>administrator with permission to post</strong>;
          for a group, it just needs to remain a member.
        </li>
        <li>
          In Hilbras Studio: <strong>Accounts → Telegram → Config</strong>.
          Paste the bot token and the chat — either the{" "}
          <code>@username</code> of the channel/group or its numeric chat ID.
        </li>
        <li>
          Save. Studio validates everything live: the token (<code>getMe</code>
          ), the chat (<code>getChat</code>), and the bot&apos;s rights there (
          <code>getChatMember</code>). Any problem is reported right in the
          dialog.
        </li>
      </ol>
      <p>
        The stored chat is the <strong>numeric ID</strong>, so renaming the
        channel&apos;s <code>@username</code> later won&apos;t break publishing.
        Bot tokens don&apos;t expire; to rotate one, reconnect with the new
        token.
      </p>

      <h2>Troubleshooting</h2>
      <ul>
        <li>
          <strong>Redirect blocked by the provider</strong> — the redirect URI
          in the developer portal must match{" "}
          <code>/api/connect/{`{platform}`}/callback</code> character for
          character, on the same origin you&apos;re using.
        </li>
        <li>
          <strong>Instagram won&apos;t publish</strong> — the account must be a
          Business or Creator profile linked to a Facebook Page.
        </li>
        <li>
          <strong>Configured but nothing happens</strong> — Config only stores
          keys; the separate <strong>Connect</strong> button performs the
          consent flow.
        </li>
        <li>
          <strong>Telegram “not a member” / “needs rights”</strong> — re-add
          the bot as channel administrator with posting permission, or check it
          wasn&apos;t kicked from the group.
        </li>
      </ul>
    </article>
  );
}
