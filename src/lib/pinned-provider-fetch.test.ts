import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { fetchPinnedProvider } from "./pinned-provider-fetch";

const servers: ReturnType<typeof createServer>[] = [];

const localResolver = async (rawUrl: string) => {
  const url = new URL(rawUrl);
  return {
    url: new URL(`http://provider.example:${url.port || "80"}${url.pathname}`),
    hostname: "provider.example",
    addresses: ["127.0.0.1"],
  };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ origin: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

describe("pinned provider transport", () => {
  it("rejects private addresses instead of using the development bypass", async () => {
    const { origin } = await listen((_request, response) => response.end("private"));

    await expect(fetchPinnedProvider(origin, { method: "GET" })).rejects.toThrow(
      /private network address/,
    );
  });

  it("passes the original hostname for HTTP Host and uses the pinned connection", async () => {
    let receivedHost = "";
    const { origin, port } = await listen((request, response) => {
      receivedHost = request.headers.host ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });

    const response = await fetchPinnedProvider(`${origin}/v1/models`, {
      method: "GET",
      resolveUrl: localResolver,
    });

    expect(response.status).toBe(200);
    expect(receivedHost).toBe(`provider.example:${port}`);
  });

  it("rejects redirects without sending a second request", async () => {
    const target = await listen((_request, response) => {
      response.end("should not be reached");
    });
    const redirector = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/private` });
      response.end();
    });

    await expect(
      fetchPinnedProvider(redirector.origin, { method: "GET", resolveUrl: localResolver }),
    ).rejects.toThrow(/redirect/i);
  });

  it("bounds response bodies", async () => {
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: "x".repeat(2048) }));
    });

    await expect(
      fetchPinnedProvider(origin, {
        method: "GET",
        maxResponseBytes: 256,
        resolveUrl: localResolver,
      }),
    ).rejects.toThrow(/response.*maximum allowed size/i);
  });

  it("applies a bounded request timeout", async () => {
    const { origin } = await listen(() => {
      // Leave the socket open; the transport must enforce its own deadline.
    });

    await expect(
      fetchPinnedProvider(origin, {
        method: "GET",
        timeoutMs: 20,
        resolveUrl: localResolver,
      }),
    ).rejects.toThrow(/timed out|aborted/i);
  });
});
