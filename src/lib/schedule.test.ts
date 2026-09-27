import { describe, expect, it } from "vitest";

import { parseLocalSchedule } from "./schedule";

describe("parseLocalSchedule", () => {
  it("parses a valid local date and time", () => {
    const result = parseLocalSchedule("2026-09-24", "14:30");

    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(8);
    expect(result?.getDate()).toBe(24);
    expect(result?.getHours()).toBe(14);
    expect(result?.getMinutes()).toBe(30);
  });

  it("rejects incomplete or invalid schedule values", () => {
    expect(parseLocalSchedule("", "14:30")).toBeNull();
    expect(parseLocalSchedule("2026-09-24", "")).toBeNull();
    expect(parseLocalSchedule("2026-02-30", "14:30")).toBeNull();
    expect(parseLocalSchedule("2026-09-24", "25:00")).toBeNull();
  });
});
