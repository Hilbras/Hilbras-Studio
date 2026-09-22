import "server-only";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard for user-configured AI provider base URLs.
 *
 * The server fetches whatever baseUrl a user saves, and error paths echo
 * response fragments back to that user — without this guard a signed-in
 * account could point a provider at internal targets (cloud metadata
 * endpoints, RFC1918 hosts) and read the replies. Every outbound provider
 * request goes through assertPublicProviderUrl first.
 *
 * Known limit: DNS is resolved here and again by fetch, so a malicious
 * authoritative server can still rebind between the two lookups; closing
 * that requires pinning the verified IP into the request itself.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
  "ip6-localhost",
  "ip6-loopback",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".localdomain",
];

/** True for loopback / private / link-local / CGNAT / benchmark addresses. */
export function isBlockedAddress(address: string): boolean {
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(addr) === 6) {
    if (addr === "::" || addr === "::1") return true;
    const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    const head = parseInt(addr.split(":")[0] ?? "", 16);
    if (Number.isNaN(head)) return true; // unparsable → refuse
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }

  const octets = addr.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
  ) {
    return true; // not a parsable address → refuse
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // "this", private, loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

/**
 * Active in production. Development skips it so localhost runtimes (Ollama,
 * LM Studio, …) keep working; set ALLOW_PRIVATE_AI_URLS=1 to make the same
 * exception in a trusted private deployment.
 */
function guardEnabled(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRIVATE_AI_URLS !== "1"
  );
}

/** Throws when the URL must not be fetched server-side. */
export async function assertPublicProviderUrl(rawUrl: string): Promise<void> {
  if (!guardEnabled()) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Provider base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error("Provider base URL host is not allowed");
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error("Provider base URL points to a private network address");
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve the provider host");
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isBlockedAddress(entry.address))
  ) {
    throw new Error("Provider base URL resolves to a private network address");
  }
}
