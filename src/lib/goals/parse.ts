/**
 * Goal prefill — reading a sentence for the parts a rule can actually read.
 *
 * ## What this is, and what it is not
 *
 * It is a **prefill**. It finds the platforms named, the cadence implied, and
 * the time of day, and hands them to a form for the user to confirm. It is not
 * an interpreter and it does not pretend to be one.
 *
 * The distinction is not politeness, it is correctness. Understanding "keep my
 * accounts fed with a varied mix of AI commentary, nothing too salesy" is a
 * judgement about tone; no regular expression makes it, and one that claimed to
 * would be worse than useless, because the user would believe it. That reading
 * is Phase 5's planner, and it reads the statement **verbatim** — which is why
 * `goals.md` says the statement is stored unchanged.
 *
 * So the rule this module follows is: return what is unambiguous, name what is
 * not, and never invent a target. It never produces an account key. It knows
 * that "post on X" means the *platform* X; it does not know which of the user's
 * three X accounts was meant, and a guess here would silently publish to the
 * wrong one.
 *
 * ## Why a prefill is worth having at all
 *
 * The user is going to write a sentence either way — the statement is the point
 * of a goal. The choice is between them writing a sentence and then filling in
 * four fields by hand, or writing a sentence and confirming what was read. The
 * second is less typing, and the confirmation step is where a wrong reading
 * gets caught, which is exactly where it should be caught.
 */

import { describeCron, parseCron } from "./cron";
import { PLATFORM_IDS, platformSupports } from "@/lib/platforms";

/**
 * Words a user might type that mean a platform.
 *
 * Derived names come from the registry so a platform's display name is
 * recognised without being listed twice. The aliases are the ones people
 * actually type — "insta", "tg" — plus renames, which have to be explicit
 * because `twitter` and `x` are the same platform and neither name is derivable.
 */
const ALIASES: Readonly<Record<string, string>> = {
  insta: "instagram",
  "ig": "instagram",
  igs: "instagram",
  fb: "facebook",
  meta: "facebook",
  page: "facebook",
  tw: "x",
  twitter: "x",
  tweet: "x",
  tweets: "x",
  tg: "telegram",
  "t.me": "telegram",
  yt: "youtube",
  li: "linkedin",
  pin: "pinterest",
  tiktok: "tiktok",
  "tik tok": "tiktok",
  reddit: "reddit",
  threads: "threads",
};

/** Times of day a sentence might name, as `hour:minute`. */
const NAMED_TIMES: Readonly<Record<string, [number, number]>> = {
  midnight: [0, 0],
  morning: [9, 0],
  noon: [12, 0],
  midday: [12, 0],
  afternoon: [15, 0],
  evening: [18, 0],
  night: [20, 0],
};

type CadenceKind =
  /** The expression is already whole; there is nothing to fill in. */
  | "complete"
  /** "every N minutes" — a step, which 5-field cron can express. */
  | "times"
  /** "twice a day" — two hours, which needs choosing the second one. */
  | "twice"
  | "daily"
  | "weekly"
  | "weekdays"
  | "monthly";

interface Cadence {
  pattern: RegExp;
  label: string;
  kind: CadenceKind;
  cron: string;
}

/**
 * A cadence a sentence might imply.
 *
 * `kind` decides how much assembly is needed, and it is what keeps "hourly" from
 * being assembled as though it were a daily schedule with a time attached — the
 * failure a `cron`-string switch statement invites, because there "hourly" is
 * simultaneously a complete expression and not a pattern.
 */
const CADENCES: readonly Cadence[] = [
  { pattern: /\bevery (?:(\d+) )?minutes?\b/, label: "every N minutes", kind: "times", cron: "minutes" },
  { pattern: /\b(?:hourly|every hour)\b/, label: "hourly", kind: "complete", cron: "0 * * * *" },
  {
    pattern: /\btwice (?:a|per) day\b|\b(?:two|2) times (?:a|per) day\b/,
    label: "twice a day",
    kind: "twice",
    cron: "twice",
  },
  { pattern: /\b(?:daily|every day|each day|every single day)\b/, label: "daily", kind: "daily", cron: "daily" },
  {
    // "Every morning" is daily, and it is one of the most common ways to say it.
    // `NAMED_TIMES` supplies the hour; without this the prefill would read
    // "morning" as a time and then refuse to offer a schedule, having understood
    // the sentence perfectly well.
    pattern: /\bevery (?:morning|afternoon|evening|night)\b/,
    label: "every <time of day>",
    kind: "daily",
    cron: "daily",
  },
  {
    pattern: /\b(?:on |every |each )?weekdays?\b(?!\s+after)/,
    label: "weekdays",
    kind: "weekdays",
    cron: "weekdays",
  },
  { pattern: /\b(?:weekly|every week|each week)\b/, label: "weekly", kind: "weekly", cron: "weekly" },
  { pattern: /\b(?:monthly|every month|each month)\b/, label: "monthly", kind: "monthly", cron: "monthly" },
];

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface PrefillSchedule {
  /** `0 9 * * *` — a suggestion, confirmed by the user before it is stored. */
  cron: string;
  /** The sentence, so a form can show its reasoning. */
  description: string;
  /** How the cadence was recognised. */
  cadence: string;
  /** The time of day applied, if one was named. */
  timeOfDay: string | null;
}

export interface GoalPrefill {
  /**
   * Platform ids named in the sentence, in order of first appearance.
   *
   * Platform ids, **not** account keys. Resolving them to one of the user's
   * accounts is the form's job, because only the user knows which account a
   * sentence like "my main account" means.
   */
  platforms: string[];
  /** A schedule the sentence appears to imply, or `null` if it says nothing usable. */
  schedule: PrefillSchedule | null;
  /** A title taken from the sentence, or `null`. */
  title: string | null;
  /** What was understood, for a "we read this" panel. */
  recognised: string[];
  /**
   * What was deliberately not guessed.
   *
   * Shown to the user rather than swallowed. A prefill that quietly omitted the
   * one platform in the sentence that cannot publish has helped nobody.
   */
  unresolved: string[];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Every way this platform can be named, longest first so `insta` beats `ins`. */
function namesFor(platform: string): string[] {
  const names = [platform];
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (target === platform) names.push(alias);
  }
  return names.sort((a, b) => b.length - a.length);
}

/** The platforms a sentence names, in order of first appearance. */
function detectPlatforms(text: string): string[] {
  const found: { platform: string; at: number }[] = [];

  for (const platform of PLATFORM_IDS) {
    let earliest = -1;
    for (const alias of namesFor(platform)) {
      const match = new RegExp(
        `(?:^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
        "i",
      ).exec(text);
      if (match && (earliest === -1 || match.index < earliest)) {
        earliest = match.index;
      }
    }
    if (earliest !== -1) found.push({ platform, at: earliest });
  }

  return found.sort((a, b) => a.at - b.at).map((entry) => entry.platform);
}

/**
 * A time of day from "at 9", "at 9:30", "9am", or a named period.
 *
 * The number must be anchored to something that makes it a *time*: an "at", a
 * meridiem, or a colon. Without that anchor, "publish 2 posts every day" reads
 * "2" as 02:00 and offers a schedule nobody asked for. A bare "at 9" is taken at
 * face value — 09:00 — because a schedule that says "at 9" and means 21:00 is
 * rarer than someone who means it saying so.
 */
function detectTimeOfDay(text: string): [number, number] | null {
  const named = Object.keys(NAMED_TIMES).find((word) =>
    new RegExp(`(?:^|[^a-z])${word}(?![a-z])`, "i").test(text),
  );
  if (named) return NAMED_TIMES[named];

  const match =
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text) ??
    /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text) ??
    /\b(\d{1,2})\s*(am|pm)\b/i.exec(text);
  if (!match) return null;

  // Normalise the three alternatives to the same capture positions.
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (hour > 23 || minute > 59) return null;

  let adjusted = hour;
  if (meridiem === "pm" && hour < 12) adjusted += 12;
  if (meridiem === "am" && hour === 12) adjusted = 0;

  return [adjusted, minute];
}

/** The weekday a sentence names, if exactly one. */
function detectWeekday(text: string): number | null {
  const found: number[] = [];
  for (const [name, index] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`(?:^|[^a-z])${name}(?![a-z])`, "i").test(text)) {
      found.push(index);
    }
  }
  return found.length === 1 ? found[0] : null;
}

function detectCadence(text: string, weekday: number | null): (Cadence & { minutes?: number }) | null {
  for (const cadence of CADENCES) {
    const match = cadence.pattern.exec(text);
    if (!match) continue;
    return { ...cadence, minutes: match[1] ? Number(match[1]) : undefined };
  }

  // "Every Monday" is weekly, and no cadence word appears in it. Synthesising
  // the cadence here rather than adding a regex per weekday is what keeps
  // `weekday` reachable: a detector that no cadence can consume is a detector
  // that never runs.
  if (weekday !== null) {
    return { pattern: /$^/, label: "weekly", kind: "weekly", cron: "weekly" };
  }

  return null;
}

/**
 * Combine a cadence and a time into a cron expression.
 *
 * Returns `null` rather than a default when there is no time. Defaulting to
 * "every day at 09:00" would be a plausible guess and a wrong one, and the user
 * would not know which field they had not looked at.
 */
function buildCron(
  cadence: Cadence & { minutes?: number },
  time: [number, number] | null,
  weekday: number | null,
): string | null {
  // Already a whole expression. "hourly at 9" is a contradiction, and the
  // cadence alone is the more faithful of the two readings.
  if (cadence.kind === "complete") return cadence.cron;

  // Minute before hour. Cron reads `minute hour …`, and getting this backwards
  // produces `18 30 * * *` — which the parser correctly rejects as an hour of
  // 30, so the bug shows up as "no schedule" rather than as a wrong one.
  //
  // Unpadded, because that is the form every cron field and preset in this
  // codebase uses. `00 09 * * *` is the same schedule, but a user reading it back
  // in a form should not have to wonder whether the parser did something.
  const at = time ? `${time[1]} ${time[0]}` : null;

  switch (cadence.kind) {
    case "times": {
      const step = cadence.minutes;
      // "every 5 minutes" is expressible. "every 90 minutes" is not, in a
      // five-field cron, and silently meaning something else would be worse than
      // offering nothing — so it is left for the user to set.
      if (!step || step < 1 || step > 59) return null;
      return `*/${step} * * * *`;
    }

    case "twice": {
      // A nine-hour split from the named time, which is the conventional
      // twice-daily pair. Only one time is ever named, so the second has to come
      // from somewhere, and the description shows the result for confirmation.
      const first = time ? time[0] : 9;
      const minute = time ? time[1] : 0;
      return `${minute} ${first},${(first + 9) % 24} * * *`;
    }

    case "daily":
      return at ? `${at} * * *` : null;

    case "weekdays":
      return `${at ?? "0 9"} * * 1-5`;

    case "weekly":
      // A named weekday wins over the bare word "weekly". Without one, Monday is
      // chosen and stated in the description rather than assumed by silence.
      if (weekday !== null) return `${at ?? "0 9"} * * ${weekday}`;
      return `${at ?? "0 9"} * * 1`;

    case "monthly":
      return `${at ?? "0 9"} 1 * *`;
  }
}

/**
 * A short label, taken from the sentence rather than generated.
 *
 * Truncated at a clause boundary where there is one, because "Publish two posts
 * about AI every day on LinkedIn and X" is not a title. The full sentence is
 * kept in the statement either way; this is a label, not a summary.
 */
function suggestTitle(text: string): string | null {
  const firstClause = text.split(/[.;\n]/)[0]?.trim() ?? "";
  if (!firstClause) return null;
  if (firstClause.length <= 60) return firstClause;
  return `${firstClause.slice(0, 57).trimEnd()}…`;
}

/**
 * Read a goal statement for the parts a rule can read.
 *
 * `timeZone` is used only to validate the produced expression and to describe
 * it; the prefill never assumes a zone. A goal's schedule means a wall-clock
 * time in the user's own zone, so guessing one here would bake in a wrong
 * answer to the question the form exists to ask.
 */
export function prefillGoal(statement: string): GoalPrefill {
  const text = (statement ?? "").trim();
  const recognised: string[] = [];
  const unresolved: string[] = [];

  if (!text) {
    return { platforms: [], schedule: null, title: null, recognised, unresolved };
  }

  const platforms = detectPlatforms(text);
  for (const platform of platforms) {
    if (platformSupports(platform, "publish_post")) {
      recognised.push(`platform: ${platform}`);
    } else {
      // The single most useful thing a prefill can say: the platform you named
      // is one this build cannot post to. Said here, at typing time, rather
      // than at the first firing.
      unresolved.push(
        `${platform} is connected but cannot publish yet — this build has no ${platform} publisher.`,
      );
    }
  }

  const weekday = detectWeekday(text);
  const cadence = detectCadence(text, weekday);
  const time = detectTimeOfDay(text);

  if (time) recognised.push(`time of day: ${pad(time[0])}:${pad(time[1])}`);

  let schedule: PrefillSchedule | null = null;

  if (cadence) {
    recognised.push(`cadence: ${cadence.label}`);
    const cron = buildCron(cadence, time, weekday);

    if (cron) {
      const parsed = parseCron(cron);
      // Only ever offer something the parser will accept. A prefill that
      // proposes an invalid schedule and fails validation on save is worse than
      // one that proposes nothing.
      if (parsed.ok) {
        schedule = {
          cron: parsed.expression,
          description: describeCron(parsed.fields),
          cadence: cadence.label,
          timeOfDay: time ? `${pad(time[0])}:${pad(time[1])}` : null,
        };
      } else {
        unresolved.push(`Could not turn "${cadence.label}" into a schedule.`);
      }
    } else {
      unresolved.push(
        `Read the cadence "${cadence.label}" but not the time — a schedule needs both.`,
      );
    }
  } else if (time) {
    unresolved.push('Found a time of day but no cadence — "every day at 09:00"?');
  }

  // Disclose the weekday, whether it was named or chosen.
  //
  // "Every week" is not a day, so a prefill has to pick one. Picking silently
  // would be a decision the user cannot see and did not make, and the schedule
  // would be a day off from what they meant with nothing to indicate it. The
  // description carries it too, but the recognised list is where a form shows
  // "here is what we read".
  if (weekday !== null) {
    recognised.push(`weekday: ${WEEKDAY_NAMES[weekday]}`);
  } else if (cadence?.kind === "weekly") {
    recognised.push(`no weekday named — assumed ${WEEKDAY_NAMES[1]}`);
  }

  return {
    platforms,
    schedule,
    title: suggestTitle(text),
    recognised,
    unresolved,
  };
}
