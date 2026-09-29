import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "./logger";

const realInfo = console.info;
const realWarn = console.warn;
const realError = console.error;

afterEach(() => {
  console.info = realInfo;
  console.warn = realWarn;
  console.error = realError;
  vi.restoreAllMocks();
});

function capture(level: "info" | "warn" | "error"): string[] {
  const lines: string[] = [];
  console[level] = (line: string) => lines.push(line);
  return lines;
}

describe("structured event logging", () => {
  it("emits one line of JSON with ts, level, event, and flat fields", () => {
    const lines = capture("info");
    log.info("publish_run_finished", { userId: "u-1", published: 2, failed: 1 });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("publish_run_finished");
    expect(entry.userId).toBe("u-1");
    expect(entry.published).toBe(2);
    expect(entry.failed).toBe(1);
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
  });

  it("routes warn and error to their own channels", () => {
    const warns = capture("warn");
    const errors = capture("error");
    const infos = capture("info");

    log.warn("token_refresh_failed", { platform: "x" });
    log.error("publish_run_aborted", { reason: "deadline" });
    log.info("token_refreshed", { platform: "instagram" });

    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!).event).toBe("token_refresh_failed");
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!).event).toBe("publish_run_aborted");
    expect(infos).toHaveLength(1);
    expect(JSON.parse(infos[0]!).event).toBe("token_refreshed");
  });

  it("works without fields", () => {
    const lines = capture("info");
    log.info("scheduler_tick");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).event).toBe("scheduler_tick");
  });
});
