import { afterEach, describe, expect, it, vi } from "vitest";

import { assertPublicProviderUrl, isBlockedAddress } from "./net-guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider network guard", () => {
  it("blocks private, loopback, link-local, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "::ffff:7f00:1",
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  it("blocks reserved documentation, protocol, multicast, and broadcast ranges", () => {
    for (const address of [
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  it("allows a public literal address in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(assertPublicProviderUrl("https://8.8.8.8/v1")).resolves.toBeUndefined();
  });

  it("rejects private literals and unsupported URL schemes", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(assertPublicProviderUrl("http://127.0.0.1/v1")).rejects.toThrow(
      /private network|host is not allowed/,
    );
    await expect(assertPublicProviderUrl("file:///etc/passwd")).rejects.toThrow(
      /http or https/,
    );
  });
});
