/**
 * Goal scheduling — cron parsing and next-firing computation.
 *
 * This module is pure: no database, no queue, no platform, no clock. The
 * scheduler's correctness rests on it, and DST arithmetic is exactly the kind
 * of thing that is only ever really tested in one timezone unless it is kept
 * here and handed a `timeZone` string. Every function takes the zone as an
 * argument and every test names the zone it is exercising.
 *
 * ## Why cron is parsed here and nowhere else
 *
 * `goals.schedule_cron` stores an **already-validated** value. Parsing happens
 * once, at the edge, before anything is written, and `goals.md` states the
 * reason: there is exactly one place a malformed schedule can be rejected, and
 * exactly one to test. The scheduler reads a string it can trust, which is why
 * `nextSlot` is given `CronFields` rather than a raw expression.
 *
 * ## The rule that catches everyone
 *
 * A schedule is a **local wall-clock** promise. "Every day at 09:00" means
 * 09:00 in the user's own zone, so on the day a zone springs forward, the post
 * goes out at 10:00 local — or, for a 02:30 schedule, not at all, because
 * 02:30 that morning does not exist. Both are handled explicitly below and
 * tested by name. A schedule stored as an instant instead would drift by an
 * hour twice a year, which is the bug this design is avoiding.
 */

/** A 5-field cron expression: `minute hour day-of-month month day-of-week`. */
export const CRON_FIELD_COUNT = 5;

export interface CronFields {
  /**
   * The grammar each field accepts. Written out in words because the forms
   * cannot appear literally in a comment without terminating it early:
   *
   *   A          a single value
   *   A-B        an inclusive range
   *   star       every value in the field's range
   *   W/N       every Nth value, counting from the low bound
   *   A-B/N      every Nth value within the range
   *   A/N        every Nth value from A to the end of the field
   *
   * Any of the above may be comma-separated to combine them.
   */
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday. 7 is accepted as an alias for 0 and normalised away. */
  daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the day-of-month field was restricted.
   *
   * Load-bearing for the day rule: Vixie cron ORs the two day fields only when
   * *both* are restricted, so this flag is not derivable from the value sets —
   * a wildcard and a full range produce the same set and opposite behaviour.
   */
  domRestricted: boolean;
  /** Whether the day-of-week field was restricted. See `domRestricted`. */
  dowRestricted: boolean;
}

export type CronParse =
  | { ok: true; fields: CronFields; expression: string }
  | {
      ok: false;
      error: string;
      /** The field that failed, for a message a user can act on. */
      field?: CronFieldName;
    };

export type CronFieldName =
  | "minute"
  | "hour"
  | "dayOfMonth"
  | "month"
  | "dayOfWeek"
  | "expression";

interface FieldSpec {
  min: number;
  max: number;
  /** 0-6 where 0 is Sunday. `true` when the field uses that scale. */
  names?: readonly string[];
  /** 1-12 where 1 is January. */
  monthNames?: readonly string[];
}

const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

const DAY_NAMES = [
  "SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT",
] as const;

const SPECS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, monthNames: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES },
];

const FIELD_NAMES: readonly CronFieldName[] = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
];

/**
 * Macros a user may reasonably type.
 *
 * Cheap to support and they make the UI presets a table lookup rather than five
 * hand-written expressions that can disagree with the parser.
 */
const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A validated expression paired with a label, for the goal form. */
export interface SchedulePreset {
  id: string;
  label: string;
  /** `0 9 * * *` */
  cron: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
  { id: "daily", label: "Every day", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "1st of the month at 09:00", cron: "0 9 1 * *" },
  { id: "twice_daily", label: "Twice a day (09:00, 18:00)", cron: "0 9,18 * * *" },
];

function parseAtom(
  token: string,
  spec: FieldSpec,
): { ok: true; value: number } | { ok: false; error: string } {
  const raw = token.trim().toUpperCase();
  const names = spec.monthNames ?? spec.names;

  if (names) {
    const index = names.indexOf(raw as (typeof names)[number]);
    if (index !== -1) {
      return { ok: true, value: spec.min + index };
    }
  }

  // Reject anything that is not a plain integer before Number() so "1e1" and
  // " 1 " cannot smuggle a value through.
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: `"${token}" is not a number.` };
  }

  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    return {
      ok: false,
      error: `${value} is outside ${spec.min}-${spec.max}.`,
    };
  }
  return { ok: true, value };
}

interface ParsedField {
  values: Set<number>;
  restricted: boolean;
}

/**
 * Parse one field: a wildcard, a single value, a range, a step, or a
 * comma-separated mix. See {@link CronFields} for the shapes a spec may take —
 * the docstring there spells out each form with literal asterisks, which cannot
 * be written inside this comment without ending it early.
 */
function parseField(
  spec: string,
  field: FieldSpec,
): { ok: true; field: ParsedField } | { ok: false; error: string } {
  const trimmed = spec.trim();
  if (!trimmed) return { ok: false, error: "The field is empty." };

  const values = new Set<number>();
  // `*` and `1-31` cover the same values and mean different things to the day
  // rule, so the restriction is recorded from the text, not the set.
  const restricted = trimmed !== "*";
  let sawWildcard = false;

  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (!piece) return { ok: false, error: "Empty list entry." };

    const [rangePart, stepPart, ...extra] = piece.split("/");
    if (extra.length > 0) {
      return { ok: false, error: `"${piece}" has more than one step.` };
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        return { ok: false, error: `Step "${stepPart}" is not a number.` };
      }
      step = Number(stepPart);
      if (step === 0) return { ok: false, error: "Step must be at least 1." };
    }

    let low: number;
    let high: number;

    if (rangePart === "*") {
      sawWildcard = true;
      low = field.min;
      high = field.max;
    } else {
      const bounds = rangePart.trim().split("-");
      if (bounds.length > 1) {
        const parsedLow = parseAtom(bounds[0], field);
        if (!parsedLow.ok) return { ok: false, error: parsedLow.error };
        const parsedHigh = parseAtom(bounds[1], field);
        if (!parsedHigh.ok) return { ok: false, error: parsedHigh.error };
        low = parsedLow.value;
        high = parsedHigh.value;
        if (low > high) {
          return { ok: false, error: `Range ${low}-${high} runs backwards.` };
        }
      } else {
        const single = parseAtom(rangePart, field);
        if (!single.ok) return { ok: false, error: single.error };
        // `5/15` means "from 5, every 15", not just 5.
        if (stepPart !== undefined) {
          low = single.value;
          high = field.max;
        } else {
          low = single.value;
          high = single.value;
        }
      }
    }

    // A step without a wildcard or a range is only meaningful as "from here on".
    if (stepPart !== undefined && rangePart !== "*" && high === low) {
      high = field.max;
    }

    for (let value = low; value <= high; value += step) {
      values.add(value);
    }
  }

  if (sawWildcard && trimmed !== "*" && values.size === field.max - field.min + 1) {
    // `*/1` covers everything, so the day rule must treat it as unrestricted.
    return { ok: true, field: { values, restricted: sawWildcard && !restricted } };
  }

  return { ok: true, field: { values, restricted } };
}

/** Replace an alias weekday with its canonical one, so consumers see one scale. */
function normalizeDaysOfWeek(fields: CronFields): CronFields {
  if (!fields.daysOfWeek.has(7)) return fields;
  const daysOfWeek = new Set(fields.daysOfWeek);
  daysOfWeek.add(0);
  daysOfWeek.delete(7);
  return { ...fields, daysOfWeek };
}

/**
 * Parse and validate a cron expression.
 *
 * Rejects rather than repairs. A goal saved with a schedule the parser only
 * *mostly* understood is a goal that fires at a time nobody chose, and the
 * scheduler is the last place that could notice.
 */
export function parseCron(expression: string): CronParse {
  const trimmed = (expression ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "The schedule is empty.", field: "expression" };
  }

  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.trim().split(/\s+/);

  if (parts.length !== CRON_FIELD_COUNT) {
    return {
      ok: false,
      error: `Expected ${CRON_FIELD_COUNT} fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
      field: "expression",
    };
  }

  const parsed: ParsedField[] = [];
  for (const [index, spec] of parts.entries()) {
    const result = parseField(spec, SPECS[index]);
    if (!result.ok) {
      return {
        ok: false,
        error: `${FIELD_NAMES[index]} field: ${result.error}`,
        field: FIELD_NAMES[index],
      };
    }
    parsed.push(result.field);
  }

  return {
    ok: true,
    expression: parts.join(" "),
    fields: normalizeDaysOfWeek({
      minutes: parsed[0].values,
      hours: parsed[1].values,
      daysOfMonth: parsed[2].values,
      months: parsed[3].values,
      daysOfWeek: parsed[4].values,
      domRestricted: parsed[2].restricted,
      dowRestricted: parsed[4].restricted,
    }),
  };
}

// --- Time zones -------------------------------------------------------------

/** Reject an unknown zone at the edge, before it becomes a stored column. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    // Throws `RangeError` for an unknown identifier.
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter for one zone, cached.
 *
 * Constructing an `Intl.DateTimeFormat` costs roughly a millisecond and the
 * next-slot search asks for it thousands of times.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `h23` rather than `hour12: false`: the latter yields hour "24" for
    // midnight in some ICU versions, which turns midnight into the next day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** The wall-clock fields an instant shows in a zone. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

const DAY_MS = 86_400_000;

/**
 * A zone's UTC offset at an instant, in milliseconds.
 *
 * Positive east of Greenwich. Derived by formatting the instant and reading the
 * result back, which is the only portable way to get a real IANA offset — the
 * alternative, `getTimezoneOffset`, only knows the *host's* zone.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Turn a local wall-clock time into an instant, or report that it never was.
 *
 * Two timezone facts make this more than a subtraction:
 *
 * - **Spring forward (a gap).** On the morning a zone jumps 02:00 -> 03:00, the
 *   wall clock passes 02:30 without showing it. `02:30` has no instant. Vixie
 *   cron skips such a firing, and so does this: the daily 02:30 goal simply
 *   does not run that morning, and the next day is unaffected.
 * - **Autumn back (a fold).** Going 03:00 -> 02:00, the wall clock shows 02:30
 *   twice. Both instants are real. The earlier one is returned, so the goal
 *   fires once rather than twice — a duplicate publish is the one failure mode
 *   the rest of the Runtime spends so much machinery preventing.
 *
 * The candidate offsets are sampled a day either side because a zone's offset
 * at the naive instant is unknowable — the naive instant is not an instant yet.
 */
function localToUtc(wall: WallClock, timeZone: string): Date | null {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    0,
  );

  const offsets = new Set<number>();
  for (const shift of [-DAY_MS, 0, DAY_MS]) {
    offsets.add(offsetAt(new Date(naive + shift), timeZone));
  }

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    const shown = zonedParts(new Date(candidate), timeZone);
    if (
      shown.year === wall.year &&
      shown.month === wall.month &&
      shown.day === wall.day &&
      shown.hour === wall.hour &&
      shown.minute === wall.minute
    ) {
      valid.push(candidate);
    }
  }

  if (valid.length === 0) return null;
  return new Date(Math.min(...valid));
}

// --- The day rule -----------------------------------------------------------

/**
 * Whether a local calendar date satisfies the day fields.
 *
 * Vixie cron's rule: when **both** day fields are restricted the date matches if
 * *either* does, so `0 0 1 * 1` fires on the 1st **and** on every Monday. It is
 * widely reimplemented as AND by mistake, and the difference is a goal that
 * fires eight times less often than the user asked for — invisible until
 * someone reads the expression and cannot reconcile it.
 */
export function dayMatches(
  fields: CronFields,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!fields.months.has(month)) return false;

  // A calendar date has one weekday everywhere, so read it from the UTC
  // rendering of the date rather than from a zone.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const domMatch = fields.daysOfMonth.has(day);
  const dowMatch = fields.daysOfWeek.has(weekday);

  if (fields.domRestricted && fields.dowRestricted) {
    return domMatch || dowMatch;
  }
  if (fields.domRestricted) return domMatch;
  if (fields.dowRestricted) return dowMatch;
  return true;
}

/**
 * Roughly four years of days.
 *
 * Long enough that any schedule which can fire at all will be found — the
 * sparsest useful one is `0 0 29 2 *`, February 29th, which is up to eight
 * years in the century calendars skip. Short enough to stop an unsatisfiable
 * expression like `0 0 30 2 *` (February 30th) in bounded work rather than
 * looping.
 */
const MAX_DAYS_AHEAD = 1500;

/**
 * The first firing strictly after `from`.
 *
 * `null` when the expression can never be satisfied — `0 0 30 2 *` names a date
 * that does not exist. A scheduler that looped forever on one would be a
 * goroutine burning a database connection per malformed goal.
 */
export function nextSlot(
  fields: CronFields,
  timeZone: string,
  from: Date,
): Date | null {
  const start = zonedParts(from, timeZone);

  // Walk local calendar days. Adding DAY_MS to a UTC midnight is safe calendar
  // arithmetic and avoids depending on a zone's DST behaviour to count days.
  const startOfDay = Date.UTC(start.year, start.month - 1, start.day);

  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);

  for (let offset = 0; offset <= MAX_DAYS_AHEAD; offset += 1) {
    const naiveDay = new Date(startOfDay + offset * DAY_MS);
    const year = naiveDay.getUTCFullYear();
    const month = naiveDay.getUTCMonth() + 1;
    const day = naiveDay.getUTCDate();

    if (!dayMatches(fields, year, month, day)) continue;

    // On the first day, hours already past cannot fire, so start the list at
    // the current hour rather than testing the whole day and discarding it.
    const firstHour =
      offset === 0
        ? hours.findIndex((hour) => hour >= start.hour)
        : 0;
    if (firstHour === -1) continue;

    for (const hour of hours.slice(firstHour)) {
      for (const minute of minutes) {
        // Inside a fold, minutes before this hour have already been seen in
        // wall-clock terms; letting them through would double-fire.
        if (offset === 0 && hour === start.hour && minute < start.minute) {
          continue;
        }

        const instant = localToUtc(
          { year, month, day, hour, minute },
          timeZone,
        );
        // A gap: this wall clock never happened. Skipped, as cron says.
        if (!instant) continue;
        if (instant.getTime() > from.getTime()) return instant;
      }
    }
  }

  return null;
}

// --- Human description ------------------------------------------------------

const DAY_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const pad = (value: number): string => String(value).padStart(2, "0");

function listDays(days: ReadonlySet<number>): string | null {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length > 5) return null;

  const names = sorted.map((day) => DAY_LABELS[day]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * A sentence a user can check their intent against.
 *
 * The schedule is a promise about time, and a raw cron string is not
 * checkable by the person who made it. Falls back to the expression rather than
 * guessing — a wrong description is worse than an unhelpful one, because the
 * user trusts the sentence and not the string.
 */
export function describeCron(fields: CronFields): string {
  const time = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

  // Every 15 minutes and friends: only meaningful when hours are unrestricted.
  if (
    fields.hours.size === 24 &&
    !fields.domRestricted &&
    !fields.dowRestricted &&
    fields.months.size === 12
  ) {
    const step = smallestStep(fields.minutes);
    if (step > 1) return `Every ${step} minutes`;
    return "Every minute";
  }

  if (fields.months.size !== 12) {
    const months = [...fields.months].sort((a, b) => a - b);
    if (months.length === 1) {
      const month = MONTH_LABELS[months[0] - 1];
      if (fields.daysOfMonth.size === 1 && !fields.dowRestricted) {
        const day = [...fields.daysOfMonth][0];
        const at = time(fields.hours.values().next().value ?? 0, fields.minutes.values().next().value ?? 0);
        return `Day ${day} of ${month} at ${at}`;
      }
      return `In ${month} at ${time(
        fields.hours.values().next().value ?? 0,
        fields.minutes.values().next().value ?? 0,
      )}`;
    }
    return `Monthly, on the ${[...fields.daysOfMonth].sort((a, b) => a - b).join(", ")}`;
  }

  const hour = [...fields.hours].sort((a, b) => a - b)[0] ?? 0;
  const minute = [...fields.minutes].sort((a, b) => a - b)[0] ?? 0;
  const at = time(hour, minute);

  if (fields.dowRestricted) {
    const days = listDays(fields.daysOfWeek);
    if (days) return `Every ${days} at ${at}`;
    return `On days ${[...fields.daysOfWeek].sort((a, b) => a - b).join(", ")} at ${at}`;
  }

  if (fields.domRestricted) {
    const days = [...fields.daysOfMonth].sort((a, b) => a - b);
    if (days.length === 1) return `Day ${days[0]} of every month at ${at}`;
    return `On the ${days.join(", ")} of every month at ${at}`;
  }

  if (fields.hours.size === 2 && fields.minutes.size === 1) {
    const sorted = [...fields.hours].sort((a, b) => a - b);
    return `Twice a day (${time(sorted[0], minute)} and ${time(sorted[1], minute)})`;
  }

  return `Every day at ${at}`;
}

/** The gap between consecutive members, or 1 for a dense set. */
function smallestStep(values: ReadonlySet<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2) return 1;
  let step = sorted[1] - sorted[0];
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1] - sorted[index];
    if (gap < step) step = gap;
  }
  return step;
}

/** A stable identifier for a firing, used as the run's idempotency slot. */
export function slotKey(at: Date): string {
  return `${at.toISOString().slice(0, 16)}Z`;
}
