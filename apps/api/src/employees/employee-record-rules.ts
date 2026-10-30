import { BadRequestException } from "@nestjs/common";

/**
 * Sense checks shared by the smaller employee records (education, qualifications, family, contacts, addresses, languages,
 * disciplinary notices, assets, important dates, extra payments, documents). Each throws a 400 that names the field, so a
 * database constraint never has to answer with a server error. Edits judge only the values being changed.
 */
const fail = (message: string, field: string): never => {
  throw new BadRequestException({ message, field });
};

/** An ISO day (YYYY-MM-DD) from a date column or string, or null. */
export function dayOf(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Text that must say something: not empty or only spaces. `undefined` means "not being set", so it is skipped. */
export function requireText(value: string | null | undefined, field: string, label: string): void {
  if (value === undefined || value === null) return;
  if (value.trim().length === 0) fail(`${label} cannot be empty.`, field);
}

/** A date a person typed: within a believable range. `allowFuture` for dates that are naturally ahead (expiry, end of contract). */
export function saneDay(value: unknown, field: string, label: string, opts: { allowFuture?: boolean; maxYearsAhead?: number; today?: Date } = {}): void {
  const d = dayOf(value);
  if (!d) return;
  if (d < "1920-01-01") fail(`${label} is too far in the past. Check the year.`, field);
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);
  if (opts.allowFuture) {
    const limit = opts.maxYearsAhead ? `${Number(today.slice(0, 4)) + opts.maxYearsAhead}${today.slice(4)}` : "2500-12-31";
    if (d > limit) fail(`${label} is too far ahead. Check the year.`, field);
  } else if (d > today) {
    fail(`${label} cannot be in the future.`, field);
  }
}

/** `first` must not be after `second` (both optional). */
export function orderedDays(first: unknown, second: unknown, field: string, message: string): void {
  const a = dayOf(first);
  const b = dayOf(second);
  if (a && b && a > b) fail(message, field);
}

const GENDERS = new Set(["male", "female", "other", "transgender"]);
export function assertValidGender(value: string | null | undefined, field = "gender"): void {
  if (value === undefined || value === null || value === "") return;
  if (!GENDERS.has(value.trim().toLowerCase())) fail("Gender must be male, female, other or transgender.", field);
}

/** Money typed by a person: more than zero, at most two decimals, not absurdly large. */
export function assertSaneMoney(value: number | undefined, field: string, label: string): void {
  if (value === undefined) return;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) fail(`${label} can have at most two decimal places (paisa).`, field);
  if (value > 1_000_000_000) fail(`${label} is too large. Check the figure.`, field);
}

/** A file's first bytes must match what it says it is, for the types where that can be told. */
export function fileMatchesDeclaredType(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length === 0) return false;
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buffer[i] === b);
  switch (mimeType) {
    case "application/pdf":
      return buffer.subarray(0, 1024).toString("latin1").includes("%PDF-");
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    default:
      return true;
  }
}
