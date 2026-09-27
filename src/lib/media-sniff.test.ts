import { describe, expect, it } from "vitest";

import { sniffImageMime } from "./media-sniff";

describe("image magic-byte sniffing", () => {
  it("recognizes supported image signatures", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(
      sniffImageMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
  });

  it("rejects empty and unsupported byte sequences", () => {
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
  });
});
