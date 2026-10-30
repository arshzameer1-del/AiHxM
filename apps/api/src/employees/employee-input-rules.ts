import { BadRequestException } from "@nestjs/common";

/**
 * Sense checks for what is typed into an employee record: names, email, phone, date of birth and joining date.
 * Same style as the CNIC/IBAN checks: a 400 that names the field. Used on hire (every field given) and on edit
 * (only the fields being changed, so an old stored value is never re-judged by an unrelated edit).
 */
export const NAME_MAX = 100;
const EMAIL_MAX = 200;
const PHONE_MAX = 40;
/** Pakistan's law does not allow employing a child under 14; a date of birth that makes the person younger on joining is a typing mistake. */
export const MIN_AGE_AT_JOINING = 14;
const EARLIEST_BIRTH_YEAR = 1920;
const EARLIEST_JOINING = "1960-01-01";
/** A hire may be entered ahead of the start date (an offer accepted for next quarter), but not years ahead. */
const MAX_DAYS_AHEAD_JOINING = 400;

const fail = (message: string, field: string): never => {
  throw new BadRequestException({ message, field });
};

const isoToday = (today: Date) => today.toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** Whole years between two ISO dates (birthday-aware). */
function yearsBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years;
}

export function assertValidPersonName(value: string | null | undefined, field: string, label: string): void {
  if (value === undefined || value === null) return;
  if (value.trim().length === 0) fail(`${label} cannot be empty.`, field);
  if (value.trim().length > NAME_MAX) fail(`${label} can be at most ${NAME_MAX} characters.`, field);
}

export function assertValidEmail(value: string | null | undefined, field = "email"): void {
  if (value === undefined || value === null || value === "") return;
  const v = value.trim();
  if (v.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) fail("Email does not look right (for example name@company.com).", field);
}

export function assertValidPhone(value: string | null | undefined, field = "phone"): void {
  if (value === undefined || value === null || value === "") return;
  const v = value.trim();
  const digits = v.replace(/\D/g, "");
  if (v.length > PHONE_MAX || !/^[0-9+()\s-]+$/.test(v) || digits.length < 7 || digits.length > 15) {
    fail("Phone must be a number of 7 to 15 digits (for example 0300-1234567 or +92 300 1234567).", field);
  }
}

/**
 * `dateOfBirth` / `dateOfJoining` are ISO dates (YYYY-MM-DD) or undefined. Pass the values the record will have after the change;
 * set `checkBirth` / `checkJoining` to the ones being changed. `today` is injectable for tests.
 */
export function assertValidEmploymentDates(
  next: { dateOfBirth?: string | null; dateOfJoining?: string | null },
  check: { birth: boolean; joining: boolean },
  today: Date = new Date()
): void {
  const todayIso = isoToday(today);
  const dob = next.dateOfBirth ? next.dateOfBirth.slice(0, 10) : null;
  const doj = next.dateOfJoining ? next.dateOfJoining.slice(0, 10) : null;
  if (check.birth && dob) {
    if (dob > todayIso) fail("Date of birth cannot be in the future.", "dateOfBirth");
    if (Number(dob.slice(0, 4)) < EARLIEST_BIRTH_YEAR) fail(`Date of birth cannot be before ${EARLIEST_BIRTH_YEAR}.`, "dateOfBirth");
  }
  if (check.joining && doj) {
    if (doj < EARLIEST_JOINING) fail("Date of joining is too far in the past. Check the year.", "dateOfJoining");
    if (doj > addDays(todayIso, MAX_DAYS_AHEAD_JOINING)) fail("Date of joining is more than a year ahead. Check the year.", "dateOfJoining");
  }
  if ((check.birth || check.joining) && dob && doj) {
    if (dob >= doj) fail("Date of birth must be before the date of joining.", "dateOfBirth");
    if (yearsBetween(dob, doj) < MIN_AGE_AT_JOINING) {
      fail(`Date of birth makes the employee younger than ${MIN_AGE_AT_JOINING} on the joining date. Check both dates.`, "dateOfBirth");
    }
  }
}
