export const AI_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Shared provider policy. The pinned transport owns timeout enforcement, so
 * the returned signal is optional and is kept for callers that still use the
 * standard Fetch API.
 */
export function aiProviderRequestInit(): RequestInit {
  return {
    redirect: "manual",
    cache: "no-store",
  };
}
