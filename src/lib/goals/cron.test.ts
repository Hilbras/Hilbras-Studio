import { describe, expect, it } from "vitest";

import {
  describeCron,
  dayMatches,
  isValidTimeZone,
  nextSlot,
  parseCron,
  SCHEDULE_PRESETS,
  slotKey,
} from "./cron";

/** Parse, and fail loudly rather than silently testing nothing. */
function fields(expression: string) {
  const parsed = parseCron(expression);
  if (!parsed.ok) throw new Error(`fixture is not a valid cron: ${expression} — ${parsed.error}`);
  return parsed.fields;
}

const iso = (value: string): Date => new Date(value);

/** The instant a schedule fires, rendered in UTC, or `null`. */
function fireAt(expression: string, timeZone: string, from: string): string | null {
  const next = nextSlot(fields(expression), timeZone, iso(from));
  return next ? next.toISOString() : null;
}

describe("cron parsing", () => {
  it("accepts the five-field form", () => {
    const parsed = parseCron("0 9 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect([...parsed.fields.hours]).toEqual([9]);
    expect([...parsed.fields.minutes]).toEqual([0]);
    expect(parsed.fields.daysOfWeek.has(0)).toBe(true);
  });

  it("expands macros rather than making the UI hand-write them", () => {
    const daily = parseCron("@daily");
    expect(daily.ok).toBe(true);
    if (!daily.ok) return;
    expect([...daily.fields.hours]).toEqual([0]);
    expect([...daily.fields.minutes]).toEqual([0]);
    expect(daily.expression).toBe("0 0 * * *");

    const hourly = parseCron("@hourly");
    expect(hourly.ok).toBe(true);
    if (!hourly.ok) return;
    // Every hour, not hour zero.
    expect([...hourly.fields.hours]).toHaveLength(24);
    expect([...hourly.fields.minutes]).toEqual([0]);

    // Case-insensitive, and a macro never reaches the scheduler.
    expect(parseCron("@Daily").ok).toBe(true);
  });

  it("rejects the wrong number of fields rather than guessing", () => {
    expect(parseCron("0 9 * *").ok).toBe(false);
    expect(parseCron("").ok).toBe(false);
    expect(parseCron("0 9 * * * *").ok).toBe(false);
  });

  it("names the field that failed, so the message is actionable", () => {
    const parsed = parseCron("0 99 * * *");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.field).toBe("hour");
    expect(parsed.error).toContain("99");
  });

  it("rejects out-of-range values", () => {
    expect(parseCron("60 9 * * *").ok).toBe(false); // minute 60
    expect(parseCron("0 24 * * *").ok).toBe(false); // hour 24
    expect(parseCron("0 9 0 * *").ok).toBe(false); // day-of-month 0
    expect(parseCron("0 9 * 13 *").ok).toBe(false); // month 13
    expect(parseCron("0 9 * * 8").ok).toBe(false); // weekday 8
  });

  it("rejects non-integers that Number() would happily accept", () => {
    // `1e1` and `0x9` both evaluate to a number. Neither is a cron field.
    expect(parseCron("1e1 9 * * *").ok).toBe(false);
    expect(parseCron("0x9 9 * * *").ok).toBe(false);
    expect(parseCron("+9 9 * * *").ok).toBe(false);
  });

  it("handles steps, ranges, and lists", () => {
    expect([...fields("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...fields("0 9-11 * * *").hours]).toEqual([9, 10, 11]);
    expect([...fields("0 9,18 * * *").hours]).toEqual([9, 18]);
    expect([...fields("0 0-6/2 * * *").hours]).toEqual([0, 2, 4, 6]);
  });

  it("reads a bare number with a step as 'from here to the end'", () => {
    // `5/20` in Vixie cron means 5, 25, 45 — not just 5.
    expect([...fields("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  it("treats a step that covers everything as unrestricted", () => {
    // `*/1` matches every value but is not the literal `*`, and the day rule
    // treats the two differently.
    expect(fields("0 9 */1 * *").domRestricted).toBe(false);
    expect(fields("0 9 1-31 * *").domRestricted).toBe(true);
  });

  it("accepts month and weekday names", () => {
    const parsed = parseCron("0 9 * JAN MON");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.fields.months]).toEqual([1]);
    expect([...parsed.fields.daysOfWeek]).toEqual([1]);
  });

  it("treats weekday 7 as Sunday", () => {
    const parsed = parseCron("0 9 * * 7");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.fields.daysOfWeek]).toEqual([0]);
  });

  it("refuses a backwards range and a zero step", () => {
    expect(parseCron("0 18-9 * * *").ok).toBe(false);
    expect(parseCron("0 */0 * * *").ok).toBe(false);
  });
});

describe("the day rule", () => {
  it("matches every day when both day fields are wildcards", () => {
    const cron = fields("0 9 * * *");
    expect(dayMatches(cron, 2026, 9, 27)).toBe(true);
    expect(dayMatches(cron, 2026, 12, 31)).toBe(true);
  });

  it("matches only Mondays when the weekday alone is restricted", () => {
    const cron = fields("0 9 * * 1");
    // 2026-09-28 is a Monday; 2026-09-27 is a Sunday.
    expect(dayMatches(cron, 2026, 9, 28)).toBe(true);
    expect(dayMatches(cron, 2026, 9, 27)).toBe(false);
  });

  it("ORs the two day fields when both are restricted", () => {
    // Vixie semantics: the 1st *and* every Monday. Reimplemented as AND by
    // mistake, this is the bug that makes a goal fire far less often than asked.
    const cron = fields("0 0 1 * 1");
    expect(dayMatches(cron, 2026, 10, 1)).toBe(true); // the 1st, a Thursday
    expect(dayMatches(cron, 2026, 9, 28)).toBe(true); // a Monday
    expect(dayMatches(cron, 2026, 9, 29)).toBe(false); // neither
  });

  it("restricts the month independently", () => {
    const cron = fields("0 9 * 12 *");
    expect(dayMatches(cron, 2026, 12, 15)).toBe(true);
    expect(dayMatches(cron, 2026, 9, 15)).toBe(false);
  });
});

describe("finding the next firing", () => {
  it("returns the same day when the time is still ahead", () => {
    expect(fireAt("0 9 * * *", "UTC", "2026-09-27T06:00:00Z")).toBe(
      "2026-09-27T09:00:00.000Z",
    );
  });

  it("rolls to tomorrow once the time has passed", () => {
    expect(fireAt("0 9 * * *", "UTC", "2026-09-27T10:00:00Z")).toBe(
      "2026-09-28T09:00:00.000Z",
    );
  });

  it("is strictly after `from`, so a slot is never re-fired", () => {
    // Exactly on a firing instant. Returning this one would let the scheduler
    // pick the same slot twice and rely on the unique constraint to save it.
    expect(fireAt("0 9 * * *", "UTC", "2026-09-27T09:00:00Z")).toBe(
      "2026-09-28T09:00:00.000Z",
    );
  });

  it("advances one minute at a time for a per-minute schedule", () => {
    expect(fireAt("* * * * *", "UTC", "2026-09-27T09:00:30Z")).toBe(
      "2026-09-27T09:01:00.000Z",
    );
  });

  it("finds the next weekday for a Mon-Fri schedule", () => {
    // 2026-09-26 is a Saturday, so the next weekday firing is Monday the 28th.
    expect(fireAt("0 9 * * 1-5", "UTC", "2026-09-26T12:00:00Z")).toBe(
      "2026-09-28T09:00:00.000Z",
    );
  });

  it("keeps a local schedule local across a UTC date boundary", () => {
    // 09:00 in Tokyo (UTC+9) is 00:00 UTC the *same* day.
    expect(fireAt("0 9 * * *", "Asia/Tokyo", "2026-09-27T06:00:00Z")).toBe(
      "2026-09-28T00:00:00.000Z",
    );
    // And the same instant in UTC is 20:00 the previous day.
    expect(fireAt("0 9 * * *", "UTC", "2026-09-27T06:00:00Z")).toBe(
      "2026-09-27T09:00:00.000Z",
    );
  });

  it("returns null for a schedule that can never fire", () => {
    // February 30th.
    expect(fireAt("0 0 30 2 *", "UTC", "2026-09-27T00:00:00Z")).toBeNull();
  });

  it("finds a leap day across a four-year gap", () => {
    // The sparsest satisfiable schedule, and the reason the search is bounded at
    // four years rather than a handful of days.
    expect(fireAt("0 12 29 2 *", "UTC", "2026-09-27T00:00:00Z")).toBe(
      "2028-02-29T12:00:00.000Z",
    );
  });
});

describe("daylight saving", () => {
  it("skips a firing whose wall-clock time does not exist", () => {
    // Europe/Berlin springs forward 2026-03-29: 02:00 -> 03:00, so 02:30 never
    // happens. A goal scheduled for 02:30 must not fire that morning — and must
    // not fire at 03:30 either, which is what a naive "add the offset" does.
    expect(fireAt("30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe(
      "2026-03-30T00:30:00.000Z", // 02:30 CEST the next day
    );
  });

  it("keeps a schedule at its local time across a spring-forward", () => {
    // 09:00 is nowhere near the transition, so it simply shifts by an hour in
    // UTC and stays 09:00 in Berlin.
    expect(fireAt("0 9 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe(
      "2026-03-29T07:00:00.000Z", // 09:00 CET
    );
    expect(fireAt("0 9 * * *", "Europe/Berlin", "2026-03-29T12:00:00Z")).toBe(
      "2026-03-30T07:00:00.000Z", // 09:00 CEST — the UTC instant moved
    );
  });

  it("fires once, not twice, when a wall clock repeats", () => {
    // Europe/Berlin falls back 2026-10-25: 03:00 -> 02:00, so 02:30 happens
    // twice. Two firings would mean two posts; the earlier instant is the one
    // that counts.
    const first = fireAt("30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z");
    expect(first).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST

    // Asking again from just after it must not return the repeated hour.
    const second = fireAt("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:01Z");
    expect(second).toBe("2026-10-26T01:30:00.000Z"); // 02:30 CET the next day
  });

  it("handles a zone with no daylight saving at all", () => {
    // Asia/Tokyo is UTC+9 with no DST. 09:00 local is 00:00 UTC, so the firing
    // lands on the same UTC date — six months apart the offset is identical.
    expect(fireAt("0 9 * * *", "Asia/Tokyo", "2026-01-01T06:00:00Z")).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(fireAt("0 9 * * *", "Asia/Tokyo", "2026-07-01T06:00:00Z")).toBe(
      "2026-07-02T00:00:00.000Z",
    );
  });

  it("skips the exact firing instant, even in a DST-free zone", () => {
    // 00:00Z *is* 09:00 in Tokyo, and `nextSlot` is strictly-after. Returning it
    // would let the scheduler pick the same slot twice and lean on the run's
    // unique constraint to save it.
    expect(fireAt("0 9 * * *", "Asia/Tokyo", "2026-01-01T00:00:00Z")).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("handles a half-hour and a negative offset", () => {
    // Kolkata is UTC+05:30, so 09:00 local is 03:30 UTC.
    expect(fireAt("0 9 * * *", "Asia/Kolkata", "2026-09-27T00:00:00Z")).toBe(
      "2026-09-27T03:30:00.000Z",
    );
    // New York in September is UTC-4, so 09:00 local is 13:00 UTC.
    expect(fireAt("0 9 * * *", "America/New_York", "2026-09-27T00:00:00Z")).toBe(
      "2026-09-27T13:00:00.000Z",
    );
  });

  it("does not read hour 24 for midnight", () => {
    // Some ICU versions render midnight as "24" under `hour12: false`, which
    // would silently push a midnight schedule to the following day.
    expect(fireAt("0 0 * * *", "Europe/Berlin", "2026-09-27T12:00:00Z")).toBe(
      "2026-09-27T22:00:00.000Z", // 00:00 CEST on the 28th
    );
  });
});

describe("time zone validation", () => {
  it("accepts real IANA zones and UTC", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects an invented zone before it becomes a stored column", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("GMT+2")).toBe(false);
  });
});

describe("describing a schedule", () => {
  it("describes the common cases in words a user can check", () => {
    expect(describeCron(fields("0 9 * * *"))).toBe("Every day at 09:00");
    expect(describeCron(fields("0 9 * * 1"))).toBe("Every Monday at 09:00");
    expect(describeCron(fields("0 9,18 * * *"))).toBe(
      "Twice a day (09:00 and 18:00)",
    );
    expect(describeCron(fields("*/15 * * * *"))).toBe("Every 15 minutes");
    expect(describeCron(fields("0 9 1 * *"))).toBe("Day 1 of every month at 09:00");
  });

  it("lists several weekdays rather than summarising them", () => {
    expect(describeCron(fields("0 9 * * 1,3,5"))).toBe(
      "Every Monday, Wednesday, and Friday at 09:00",
    );
  });

  it("falls back to a real description rather than a wrong one", () => {
    // An expression the describer has no sentence for still gets something
    // true. A wrong description is worse than an unhelpful one.
    const described = describeCron(fields("15 3 * 2 *"));
    expect(described).toContain("February");
  });
});

describe("presets", () => {
  it("are all valid expressions", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const parsed = parseCron(preset.cron);
      expect(parsed.ok, `${preset.id}: ${preset.cron}`).toBe(true);
    }
  });

  it("each resolve to a concrete next firing", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const next = nextSlot(fields(preset.cron), "Europe/Berlin", iso("2026-09-27T12:00:00Z"));
      expect(next, `${preset.id} found no slot`).not.toBeNull();
    }
  });
});

describe("slot keys", () => {
  it("are stable to the minute and carry a zone marker", () => {
    // The run's idempotency key is derived from this, so two firings a minute
    // apart must not collide and a DST-shifted local time must not either.
    expect(slotKey(iso("2026-09-27T09:00:00.000Z"))).toBe("2026-09-27T09:00Z");
    expect(slotKey(iso("2026-09-27T09:00:59.999Z"))).toBe("2026-09-27T09:00Z");
    expect(slotKey(iso("2026-09-27T09:01:00.000Z"))).toBe("2026-09-27T09:01Z");
  });
});
