const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * Parse a browser date/time input into the user's local timezone.
 *
 * `new Date("YYYY-MM-DDTHH:mm")` is convenient but accepts overflow dates and
 * silently rolls them into another month/day. Comparing the constructed fields
 * back to the input keeps an invalid schedule from becoming a valid-looking
 * publish time.
 */
export function parseLocalSchedule(dateValue: string, timeValue: string): Date | null {
  const dateMatch = DATE_PATTERN.exec(dateValue);
  const timeMatch = TIME_PATTERN.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) {
    return null;
  }

  const result = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day ||
    result.getHours() !== hour ||
    result.getMinutes() !== minute
  ) {
    return null;
  }

  return result;
}
