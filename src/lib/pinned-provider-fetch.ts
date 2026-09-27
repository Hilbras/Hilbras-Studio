import "server-only";

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";

import { AI_PROVIDER_TIMEOUT_MS } from "@/lib/ai-fetch";
import { resolvePublicProvider } from "@/lib/net-guard";

/** Keep provider responses bounded before they enter memory or an SDK parser. */
export const AI_PROVIDER_MAX_RESPONSE_BYTES = 1_048_576;

/** A transport policy error whose message is safe to show to a caller. */
export class ProviderTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

export interface PinnedProviderRequestInit
  extends Omit<RequestInit, "signal" | "method"> {
  signal?: AbortSignal | null;
  method?: string;
  /** Override for focused tests; production uses the shared 30-second bound. */
  timeoutMs?: number;
  /** Override for focused tests; production uses the shared one-megabyte bound. */
  maxResponseBytes?: number;
  /**
   * Resolve and validate the URL, then use the returned address for the socket.
   * Production never supplies this; tests use it to exercise a local server
   * without weakening the production DNS guard.
   */
  resolveUrl?: (rawUrl: string) => Promise<{
    url: URL;
    hostname: string;
    addresses: string[];
  }>;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (typeof headers.forEach === "function") {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return Object.fromEntries(Object.entries(headers));
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new Error("Provider request body must be a string or byte buffer");
}

function addAbortListener(
  signal: AbortSignal,
  listener: () => void,
): () => void {
  if (signal.aborted) {
    listener();
    return () => undefined;
  }
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

/**
 * Read at most `limit` bytes, rejecting an oversized body as soon as the
 * limit is crossed. This protects callers from an upstream sending an
 * unbounded JSON or error response.
 */
export async function readBoundedResponseBody(
  response: IncomingMessage,
  limit = AI_PROVIDER_MAX_RESPONSE_BYTES,
): Promise<Buffer> {
  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
    response.resume();
    throw new ProviderTransportError("Provider request returned a redirect");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) {
      response.destroy();
      throw new ProviderTransportError(
        "Provider response exceeded the maximum allowed size",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Perform an HTTP request to a user-configured provider using the DNS answer
 * that was already validated by `resolvePublicProvider`.
 *
 * The custom `lookup` callback is the important part: Node's HTTP client would
 * otherwise resolve the hostname again, creating a DNS-rebinding window. The
 * request still carries the original Host header and TLS `servername`, while
 * the socket connects only to an address that passed the SSRF guard.
 */
export async function fetchPinnedProvider(
  rawUrl: string,
  init: PinnedProviderRequestInit = {},
): Promise<Response> {
  const resolver = init.resolveUrl ?? resolvePublicProvider;
  const resolved = await resolver(rawUrl);
  const { url, hostname, addresses } = resolved;
  const timeoutMs = init.timeoutMs ?? AI_PROVIDER_TIMEOUT_MS;
  const maxResponseBytes = init.maxResponseBytes ?? AI_PROVIDER_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal ?? undefined;
  const removeExternalAbort = externalSignal
    ? addAbortListener(externalSignal, () => controller.abort())
    : undefined;

  try {
    const body = bodyToBuffer(init.body);
    const headers = normalizeHeaders(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestOptions: Parameters<typeof httpsRequest>[1] = {
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...headers,
        host: url.host,
      },
      servername: url.protocol === "https:" ? hostname : undefined,
      lookup: (
        _lookupHostname: string,
        _options: LookupOptions,
        callback: (
          error: NodeJS.ErrnoException | null,
          address: string | LookupAddress[],
          family?: number,
        ) => void,
      ) => {
        const address = addresses[0];
        if (!address) {
          callback(new Error("Provider host had no usable address"), "", 0);
        } else if (_options.all) {
          callback(
            null,
            addresses.map((candidate) => ({
              address: candidate,
              family: isIP(candidate),
            })),
          );
        } else {
          callback(null, address, isIP(address));
        }
      },
      rejectUnauthorized: true,
    };

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = requestFn(url, requestOptions, resolve);
      req.once("error", reject);
      const removeAbort = addAbortListener(controller.signal, () => {
        req.destroy(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("Provider request aborted"),
        );
      });
      req.once("close", removeAbort);
      if (body) req.write(body);
      req.end();
    });

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(key, item);
      } else if (value !== undefined) {
        responseHeaders.set(key, value);
      }
    }
    const bodyBuffer = await readBoundedResponseBody(response, maxResponseBytes);
    return new Response(new Uint8Array(bodyBuffer), {
      status: response.statusCode ?? 502,
      statusText: response.statusMessage,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderTransportError("Provider request timed out or was aborted");
    }
    if (error instanceof Error) {
      // Do not forward an upstream URL, IP, or socket detail to the browser.
      // Callers need to know the request failed, not which internal address
      // or filesystem path happened to be involved.
      const safe = new ProviderTransportError("Provider request failed");
      safe.cause = error;
      throw safe;
    }
    throw new ProviderTransportError("Provider request failed");
  } finally {
    clearTimeout(timer);
    removeExternalAbort?.();
  }
}
