import "server-only";

import { PLATFORM_REGISTRY, type PlatformId } from "@/lib/platforms";

/**
 * Are the saved app credentials really this platform's developer app?
 *
 * A connect attempt hands the browser to the platform's own authorize URL, which
 * is a dead end when the app ID belongs to something else: Meta answers with a
 * page that only says *"Authorization Failed: No app ID was sent with the
 * request."* (error 4476002) and the user comes back to the app with nothing to
 * act on. Meta apps are the sharpest case — one Meta app issues **two** app IDs,
 * a Facebook/Instagram pair and a Threads pair, and only the Threads pair is
 * accepted by `graph.threads.net`, so pasting the Instagram pair into the Threads
 * fields is an easy mistake that the platform reports as if no app ID were sent.
 *
 * The check reuses the platform's token endpoint: an authorization-code exchange
 * with a deliberately bogus code. OAuth servers validate the client *before* they
 * look at the code, so the answer separates the two failures:
 *
 *   - "invalid client_id" / "invalid_client" → this app pair is wrong here
 *   - "invalid_grant", "invalid_request", "…authorization code" → the app pair is
 *     fine and only the probe code was rejected
 *   - no response / anything unexpected → unverified, and callers fail open so a
 *     provider outage never blocks a connect or turns a good key red
 */
export type AppCredentialVerdict =
  | { status: "valid"; message: string }
  | { status: "invalid"; code: string; message: string }
  | { status: "unverified"; message: string };

/** Credentials the platform does not recognise at all. */
const INVALID_APP =
  /invalid[_ ]client|unknown client|invalid app|app[_ ]?id.{0,20}(invalid|not found)|invalid client_secret|client id is invalid/i;

/** Failures that are about our throwaway code, not the app credentials. */
const PROBE_ONLY =
  /invalid_grant|invalid_request|unsupported_grant_type|missing required field: (code|redirect_uri|client_secret|grant_type)|authorization code|verification code|redirect_uri|invalid_scope/i;

/** Meta's two-app-ID trap, spelled out where the user actually sees it. */
export const THREADS_APP_ID_HINT =
  "This is not a Threads app ID. A Meta app hands out two pairs — copy the Threads app ID and secret from the app's Threads use case (Settings → Threads), not the Instagram/Facebook pair.";

interface ProviderError {
  message: string;
  code: string;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * Providers disagree on error shape: Meta/Threads nest
 * `{ error: { message, code, type } }`, older Instagram returns
 * `{ error_type, error_message }`, and standards-compliant OAuth returns
 * `{ error, error_description }`. `body.error` may therefore be a string *or* an
 * object — reading it as a string throws and hides the real reason.
 */
export function readProviderError(body: unknown): ProviderError {
  if (!body || typeof body !== "object") return { message: "", code: "" };

  const flat = body as Record<string, unknown>;
  const nested =
    typeof flat.error === "object" && flat.error !== null
      ? (flat.error as Record<string, unknown>)
      : null;

  return {
    message: firstString(
      typeof flat.error === "string" ? flat.error : "",
      nested?.message,
      flat.error_description,
      flat.error_message,
      flat.message,
      flat.detail
    ),
    code: firstString(
      nested?.code === undefined ? "" : String(nested.code),
      nested?.type,
      typeof flat.error === "string" ? flat.error : "",
      flat.error_code === undefined ? "" : String(flat.error_code),
      flat.error_type
    ),
  };
}

/**
 * Probe one platform's app credentials. Never throws — a network failure is
 * reported as `unverified`, not as a bad key.
 */
export async function verifyAppCredentials(
  platformId: PlatformId,
  credentials: { clientId: string; clientSecret: string }
): Promise<AppCredentialVerdict> {
  const platform = PLATFORM_REGISTRY[platformId];
  if (!platform) {
    return { status: "unverified", message: `Unknown platform: ${platformId}` };
  }
  // Manual platforms (Telegram) have no token endpoint to probe against.
  if (!platform.auth) {
    return {
      status: "unverified",
      message: `${platform.name} does not use OAuth app credentials.`,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (platform.auth.extraHeaders) Object.assign(headers, platform.auth.extraHeaders);

  let res: Response;
  try {
    res = await fetch(platform.auth.tokenUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "authorization_code",
        code: "hilbras-app-credential-check",
      }).toString(),
    });
  } catch {
    return {
      status: "unverified",
      message: `Could not reach ${platform.name} to check the credentials.`,
    };
  }

  const body = (await res.json().catch(() => null)) as unknown;
  const { message, code } = readProviderError(body);
  const haystack = `${message} ${code}`.trim();

  if (INVALID_APP.test(haystack)) {
    return {
      status: "invalid",
      code:
        platformId === "threads"
          ? "threads_app_id_invalid"
          : `${platformId}_app_credentials_invalid`,
      message:
        platformId === "threads"
          ? THREADS_APP_ID_HINT
          : `Rejected by ${platform.name}: ${message || "these app credentials are not valid"}.`,
    };
  }

  if (res.ok || PROBE_ONLY.test(haystack)) {
    return {
      status: "valid",
      // Deliberately narrow: providers reject the probe code before (or instead
      // of) validating the secret — Threads answers "Invalid verification code"
      // even for a wrong secret — so this proves the *app ID* is theirs, not that
      // the pair is complete. Saying more here would recreate the false
      // reassurance that sent users to the provider's error page.
      message: `${platform.name} accepted this app ID. A wrong client secret is not always visible here — some providers only check it during the real authorization-code exchange.`,
    };
  }

  return {
    status: "unverified",
    message: `${platform.name} returned an unexpected response (HTTP ${res.status}${message ? `: ${message}` : ""}).`,
  };
}