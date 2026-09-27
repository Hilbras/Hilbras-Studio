import { describe, expect, it } from "vitest";

import { isThreadsPermissionError } from "./threads-errors";

describe("Threads permission error classification", () => {
  it("recognizes the stable error code and subcode", () => {
    expect(
      isThreadsPermissionError({
        error: {
          code: 100,
          error_subcode: 10,
          message: "This action requires the threads_basic permission.",
        },
      }),
    ).toBe(true);
  });

  it("falls back to the stable message when subcodes are absent", () => {
    expect(
      isThreadsPermissionError({
        error: {
          message: "This action requires the threads_basic permission.",
        },
      }),
    ).toBe(true);
  });

  it("does not classify unrelated API errors as missing permissions", () => {
    expect(isThreadsPermissionError({ error: { code: 190 } })).toBe(false);
    expect(isThreadsPermissionError("not an object")).toBe(false);
  });
});
