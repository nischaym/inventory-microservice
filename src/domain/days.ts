const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 86_400_000;

/** How far past today (UTC) a feedDate may be, absorbing time-zone skew (D-10). */
export const MAX_FEED_DATE_LEAD_DAYS = 1;

/** Days since 1970-01-01 for a real `YYYY-MM-DD` date, or undefined if the input is not one. */
function toEpochDay(date: string): number | undefined {
  const match = CALENDAR_DATE_PATTERN.exec(date);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  const isRoundTrip =
    instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
  return isRoundTrip ? instant.getTime() / MILLISECONDS_PER_DAY : undefined;
}

function requireEpochDay(date: string): number {
  const epochDay = toEpochDay(date);
  if (epochDay === undefined) {
    throw new RangeError(`Not a valid YYYY-MM-DD calendar date: "${date}"`);
  }
  return epochDay;
}

export function isCalendarDate(value: string): boolean {
  return toEpochDay(value) !== undefined;
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return requireEpochDay(to) - requireEpochDay(from);
}

/** FR-13: days from stockedOn to the reference date, never negative (A-5). */
export function daysInInventory(stockedOn: string, referenceDate: string): number {
  return Math.max(0, daysBetween(stockedOn, referenceDate));
}

/** D-10: a feedDate more than MAX_FEED_DATE_LEAD_DAYS after today (UTC) is rejected. */
export function isFeedDateTooFarAhead(feedDate: string, todayUtc: string): boolean {
  return daysBetween(todayUtc, feedDate) > MAX_FEED_DATE_LEAD_DAYS;
}

/** A-7: the calendar date of an instant in UTC. Throws RangeError for an invalid Date. */
export function toUtcCalendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
