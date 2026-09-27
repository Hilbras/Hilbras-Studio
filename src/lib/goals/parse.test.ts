import { describe, expect, it } from "vitest";

import { parseCron } from "./cron";
import { prefillGoal } from "./parse";

describe("goal prefill", () => {
  it("reads the platforms out of a sentence", () => {
    const result = prefillGoal("Publish two posts about AI every day on LinkedIn and X.");

    expect(result.platforms).toEqual(["linkedin", "x"]);
  });

  it("reads platforms in the order they were mentioned", () => {
    // Order is the user's own; a sorted list would misrepresent a sentence where
    // the first platform is the main one.
    expect(prefillGoal("Post to X and Instagram daily").platforms).toEqual([
      "x",
      "instagram",
    ]);
  });

  it("recognises the names people actually type", () => {
    expect(prefillGoal("cross-post to insta and tg").platforms).toEqual([
      "instagram",
      "telegram",
    ]);
    // Twitter is the same platform as X, and a rename has to be explicit.
    expect(prefillGoal("tweet from twitter daily").platforms).toEqual(["x"]);
  });

  it("does not match a platform name inside another word", () => {
    // The bug this prevents: "x" matching "extra" or "box", so an unrelated
    // sentence silently prefills a target.
    expect(prefillGoal("Extra content about boxing techniques").platforms).toEqual([]);
    expect(prefillGoal("ideas for the extraordinary").platforms).toEqual([]);
  });

  it("never invents an account key", () => {
    // A sentence says which *platform*; only the user knows which of their three
    // accounts. Guessing here would publish to the wrong one, silently.
    const result = prefillGoal("Post on X every day at 9");

    expect(result.platforms).toEqual(["x"]);
    for (const value of [...result.platforms, ...Object.values(result)]) {
      expect(JSON.stringify(value)).not.toContain("x:");
    }
  });

  it("reads a daily schedule with a time", () => {
    const result = prefillGoal("Post something on X every day at 9am");

    expect(result.schedule?.cron).toBe("0 9 * * *");
    expect(result.schedule?.description).toBe("Every day at 09:00");
  });

  it("reads a daily schedule with a colon and a meridiem", () => {
    expect(prefillGoal("daily at 18:30 on instagram").schedule?.cron).toBe(
      "30 18 * * *",
    );
    expect(prefillGoal("daily at 8:15 pm on instagram").schedule?.cron).toBe(
      "15 20 * * *",
    );
  });

  it("reads 12am and 12pm correctly", () => {
    expect(prefillGoal("daily at 12am on x").schedule?.cron).toBe("0 0 * * *");
    expect(prefillGoal("daily at 12pm on x").schedule?.cron).toBe("0 12 * * *");
  });

  it("reads a named time of day", () => {
    // "every morning" is daily, and the hour comes from the phrase. Both halves
    // have to be read for either to mean anything.
    expect(prefillGoal("post on X every morning").schedule?.cron).toBe("0 9 * * *");
    expect(prefillGoal("post on X every evening").schedule?.cron).toBe("0 18 * * *");
    expect(prefillGoal("post on X at midnight daily").schedule?.cron).toBe(
      "0 0 * * *",
    );
  });

  it("does not read a post count as a time of day", () => {
    // "2 posts every day" is a count. Reading "2" as 02:00 and offering a
    // 2am schedule nobody asked for is the kind of confident wrong answer that
    // makes a prefill untrustworthy.
    const result = prefillGoal("Publish 2 posts every day on X");

    expect(result.platforms).toEqual(["x"]);
    expect(result.schedule).toBeNull();
    expect(result.unresolved.join(" ")).toContain("not the time");
  });

  it("reads weekdays, weeks, and months", () => {
    expect(prefillGoal("post on X every weekday at 8am").schedule?.cron).toBe(
      "0 8 * * 1-5",
    );
    expect(prefillGoal("post on X every Monday at 8am").schedule?.cron).toBe(
      "0 8 * * 1",
    );
    expect(prefillGoal("post on X every Friday at 8am").schedule?.cron).toBe(
      "0 8 * * 5",
    );
    expect(prefillGoal("post on X monthly at 9am").schedule?.cron).toBe(
      "0 9 1 * *",
    );
  });

  it("names the weekday it chose when the sentence only said 'weekly'", () => {
    // "Every week" is not a day. Monday is chosen, and the description says so
    // so the user can see the choice rather than discover it later.
    const result = prefillGoal("post on X weekly at 9am");

    expect(result.schedule?.cron).toBe("0 9 * * 1");
    expect(result.schedule?.description).toBe("Every Monday at 09:00");
    expect(result.recognised.join(" ")).toContain("Monday");
  });

  it("reads a step cadence", () => {
    expect(prefillGoal("post on X every 30 minutes").schedule?.cron).toBe(
      "*/30 * * * *",
    );
  });

  it("declines a step that five-field cron cannot express", () => {
    // "every 90 minutes" has no 5-field representation. Producing one would
    // silently mean something else, so it says so instead.
    const result = prefillGoal("post on X every 90 minutes");

    expect(result.schedule).toBeNull();
    expect(result.unresolved.length).toBeGreaterThan(0);
  });

  it("reads 'hourly' as a complete expression", () => {
    // The bug a `cron`-string switch invites: treating "hourly" as a daily
    // pattern that still needs a time, and then either dropping the cadence or
    // attaching a made-up time to it.
    expect(prefillGoal("post on X hourly").schedule?.cron).toBe("0 * * * *");
  });

  it("prefers the cadence over a contradictory time", () => {
    // "hourly at 9" is a contradiction. The cadence is the more faithful of the
    // two readings, and a once-an-hour schedule is what "hourly" means.
    expect(prefillGoal("post on X hourly at 9").schedule?.cron).toBe("0 * * * *");
  });

  it("never proposes a schedule its own parser would reject", () => {
    // The prefill and the validator must agree, or the form offers a value that
    // fails on save — which is worse than offering nothing.
    const statements = [
      "post on X every day at 9am",
      "post on X every 30 minutes",
      "post on X every weekday at 8am",
      "post on X weekly at 9am",
      "post on X monthly at 9am",
      "post on X hourly",
      "post on X every Friday evening",
      "post on X twice a day at 9am",
      "post on X every 5 minutes",
    ];

    for (const statement of statements) {
      const cron = prefillGoal(statement).schedule?.cron;
      if (!cron) continue;
      expect(parseCron(cron).ok, `${statement} -> ${cron}`).toBe(true);
    }
  });

  it("refuses to guess a time when only a cadence was given", () => {
    // Defaulting to 09:00 would be plausible and wrong, and the user would not
    // know which field they had not looked at.
    const result = prefillGoal("post on X every day");

    expect(result.schedule).toBeNull();
    expect(result.unresolved.join(" ")).toContain("not the time");
  });

  it("refuses to guess a cadence when only a time was given", () => {
    const result = prefillGoal("post on X at 9am");

    expect(result.schedule).toBeNull();
    expect(result.unresolved.join(" ")).toContain("no cadence");
  });

  it("says so when a named platform cannot publish", () => {
    // The most useful thing a prefill can do: catch the impossible platform at
    // typing time rather than at the first firing, when the only symptom is
    // silence.
    const result = prefillGoal("Post about AI on LinkedIn every day at 9am");

    expect(result.platforms).toEqual(["linkedin"]);
    expect(result.recognised).not.toContain("platform: linkedin");
    expect(result.unresolved.join(" ")).toContain("linkedin");
    expect(result.unresolved.join(" ")).toContain("cannot publish");
  });

  it("does not warn about a platform that can publish", () => {
    const result = prefillGoal("Post about AI on X every day at 9am");

    expect(result.recognised).toContain("platform: x");
    expect(result.unresolved).toEqual([]);
  });

  it("suggests a title from the first clause", () => {
    expect(prefillGoal("Daily AI commentary. Nothing too salesy.").title).toBe(
      "Daily AI commentary",
    );
  });

  it("truncates a title rather than showing a whole paragraph", () => {
    const long = "a".repeat(200);
    expect(prefillGoal(long).title).toHaveLength(58);
  });

  it("returns nothing for an empty statement instead of throwing", () => {
    for (const empty of ["", "   "]) {
      const result = prefillGoal(empty);
      expect(result.platforms).toEqual([]);
      expect(result.schedule).toBeNull();
      expect(result.title).toBeNull();
    }
  });

  it("does not treat an unmatched weekday as a named one", () => {
    // "Monday and Friday" names two days, which "every week" cannot express. The
    // weekday is dropped rather than one of them being picked silently.
    const result = prefillGoal("post on X weekly on Monday and Friday");

    expect(result.schedule?.cron).toBe("0 9 * * 1");
    expect(result.recognised.join(" ")).not.toContain("weekday: Friday");
  });
});
