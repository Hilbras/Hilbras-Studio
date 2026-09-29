/**
 * Server-side validation for connector publish results (remediation Tasks 7/11).
 *
 * Every field in a PublishResult originates in a third-party API response, so
 * results are validated before they reach a caller or the database: result URLs
 * must parse as https: and point at the platform's own hosts, and text fields
 * are bounded so a broken or hostile provider response cannot park unbounded
 * content in the DOM or the posts table.
 */

/** Hosts a platform's result URL is allowed to point at. */
const RESULT_URL_HOSTS: Record<string, readonly string[]> = {
  instagram: ["instagram.com", "www.instagram.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com"],
  threads: ["threads.net", "www.threads.net"],
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  telegram: ["t.me", "www.t.me", "telegram.me"],
};

/** Upper bound for result text fields (error messages, platform ids). */
const MAX_RESULT_TEXT = 2000;

/** Structural twin of publish.ts's PublishResult (avoids an import cycle). */
export interface SanitizablePublishResult {
  platform: string;
  success: boolean;
  postId?: string;
  error?: string;
  url?: string;
}

/**
 * Return `raw` only if it parses as an https: URL whose host belongs to
 * `platform`'s own hosts. Anything else becomes undefined — a missing link
 * beats a link a platform response should never have produced.
 */
export function sanitizeResultUrl(
  platform: string,
  raw: string | undefined
): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const hosts = RESULT_URL_HOSTS[platform];
  if (!hosts) return undefined;
  if (!hosts.includes(parsed.hostname.toLowerCase())) return undefined;
  return parsed.toString();
}

function boundText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_RESULT_TEXT
    ? trimmed.slice(0, MAX_RESULT_TEXT)
    : trimmed;
}

/** Validate one connector result before it is returned to a caller or stored. */
export function sanitizePublishResult(
  result: SanitizablePublishResult
): SanitizablePublishResult {
  const clean: SanitizablePublishResult = {
    platform: boundText(result.platform)?.slice(0, 50) ?? "unknown",
    success: result.success === true,
  };
  const postId = boundText(result.postId);
  if (postId) clean.postId = postId;
  const error = boundText(result.error);
  if (error) clean.error = error;
  const url = sanitizeResultUrl(clean.platform, result.url);
  if (url) clean.url = url;
  return clean;
}

export function sanitizePublishResults(
  results: SanitizablePublishResult[]
): SanitizablePublishResult[] {
  return results.map(sanitizePublishResult);
}
