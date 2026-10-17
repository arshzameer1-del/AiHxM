import type { EmployeeView, MyPersonalDataView, PersonVersionView } from "@aihxm/shared-types";
import { formatDay, localDayKey } from "../shared/dates";

/**
 * "My Personal Data" - the rows of the SAP-style screen, built from the person record (and its dated slices)
 * plus the field-rule-filtered employee record. Pure, so it can be tested without a browser.
 *
 * Groups follow SAP's My Personal Data app, trimmed to what Pakistan HR actually keeps:
 *   Name, Birth data, Marital status, Identification (CNIC / passport / NTN).
 */

export type PersonalRow = {
  key: string;
  label: string;
  value: string;
  /** Hidden behind "Show" until the person asks (ID numbers). */
  masked?: boolean;
};
export type PersonalGroup = { key: string; title: string; rows: PersonalRow[] };

/** A dated slice the person can look at: the current one or an earlier one. */
export type PersonalSlice = {
  key: string;
  validFrom: string;
  validTo: string | null;
  /** The record in force today. */
  current: boolean;
  /** Recorded already but takes effect later. */
  upcoming: boolean;
  data: SliceData;
};

export type SliceData = {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
  title: string | null;
  gender: string | null;
  nationality: string | null;
  secondNationality: string | null;
  language: string | null;
  maritalStatus: string | null;
  maritalStatusDate: string | null;
  placeOfBirth: string | null;
  nationalIdType: string | null;
  passportExpiry: string | null;
};

const NATIONAL_ID_LABELS: Record<string, string> = {
  cnic: "CNIC",
  nicop: "NICOP",
  passport: "Passport",
  b_form: "B-Form",
  other: "Other ID",
};

const clean = (v: string | null | undefined): string => (v ?? "").trim();
const titleCase = (v: string): string => v.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "A. K." style initials from first, middle and last name. */
export function initialsOf(first: string | null | undefined, middle: string | null | undefined, last: string | null | undefined): string {
  return [first, middle, last]
    .map((n) => clean(n)[0])
    .filter(Boolean)
    .map((c) => `${c!.toUpperCase()}.`)
    .join(" ");
}

/** Keeps the last four characters, hides the rest ("•••• •••• 4821"). */
export function maskId(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return v;
  return `${"•".repeat(Math.min(8, v.length - 4))} ${v.slice(-4)}`;
}

function sliceFromVersion(v: PersonVersionView): SliceData {
  return {
    firstName: v.firstName, middleName: v.middleName, lastName: v.lastName, preferredName: v.preferredName, title: v.title,
    gender: v.gender, nationality: v.nationality, secondNationality: v.secondNationality, language: v.language,
    maritalStatus: v.maritalStatus, maritalStatusDate: v.maritalStatusDate, placeOfBirth: v.placeOfBirth,
    nationalIdType: v.nationalIdType, passportExpiry: v.passportExpiry,
  };
}

/**
 * Newest first. The current slice is the one in force today (a change dated next month is "upcoming", not current).
 * With no history, one slice built from the person record or, failing that, the employee record.
 */
export function buildSlices(data: MyPersonalDataView | null, employee: EmployeeView, today: string = localDayKey(new Date())): PersonalSlice[] {
  const history = data?.history ?? [];
  if (history.length > 0) {
    const sorted = [...history].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return sorted.map((v) => {
      const upcoming = v.validFrom > today;
      const current = !upcoming && (v.validTo === null || v.validTo >= today);
      return { key: v.id, validFrom: v.validFrom, validTo: v.validTo, current, upcoming, data: sliceFromVersion(v) };
    });
  }
  const person = data?.person;
  return [
    {
      key: "current",
      validFrom: employee.dateOfJoining,
      validTo: null,
      current: true,
      upcoming: false,
      data: person
        ? currentFromPerson(data!)
        : {
            firstName: employee.firstName, middleName: null, lastName: employee.lastName, preferredName: null, title: null,
            gender: employee.gender, nationality: null, secondNationality: null, language: null,
            maritalStatus: employee.maritalStatus, maritalStatusDate: null, placeOfBirth: null, nationalIdType: null, passportExpiry: null,
          },
    },
  ];
}

function currentFromPerson(data: MyPersonalDataView): SliceData {
  const p = data.person!;
  return {
    firstName: p.firstName, middleName: p.middleName, lastName: p.lastName, preferredName: p.preferredName, title: p.title,
    gender: p.gender, nationality: p.nationality, secondNationality: p.secondNationality, language: p.language,
    maritalStatus: p.maritalStatus, maritalStatusDate: p.maritalStatusDate, placeOfBirth: p.placeOfBirth,
    nationalIdType: p.nationalIdType, passportExpiry: p.passportExpiry,
  };
}

/** "Valid from 1 Sep 2026" for the current or an upcoming slice, "Valid 1 Sep 2025 – 31 Aug 2026" for an earlier one. */
export function sliceTitle(slice: PersonalSlice): string {
  if (slice.current || slice.upcoming || !slice.validTo) return `Valid from ${formatDay(slice.validFrom)}`;
  return `Valid ${formatDay(slice.validFrom)} – ${formatDay(slice.validTo)}`;
}

const show = (v: string | null | undefined, fallback = "—"): string => (clean(v) ? clean(v) : fallback);

/**
 * The grouped rows for one slice. Things that are not dated (date of birth, ID numbers) are only shown on the
 * current slice, and only when the caller is allowed to see them (`key in employee`, the same rule EmployeeFields uses).
 */
export function buildGroups(slice: PersonalSlice, employee: EmployeeView, data: MyPersonalDataView | null): PersonalGroup[] {
  const s = slice.data;
  const p = data?.person ?? null;
  const showUndated = slice.current;

  const birth: PersonalRow[] = [];
  if (showUndated && "dateOfBirth" in employee) birth.push({ key: "dateOfBirth", label: "Date of birth", value: show(formatDay(employee.dateOfBirth ?? null)) });
  birth.push(
    { key: "placeOfBirth", label: "Place of birth", value: show(s.placeOfBirth) },
    { key: "gender", label: "Gender", value: s.gender ? titleCase(s.gender) : "—" },
    { key: "nationality", label: "Nationality", value: show(s.nationality) },
    { key: "secondNationality", label: "Second nationality", value: show(s.secondNationality) },
    { key: "language", label: "Communication language", value: show(s.language) }
  );

  const ident: PersonalRow[] = [];
  if (showUndated) {
    if ("cnic" in employee) ident.push({ key: "cnic", label: "CNIC", value: show(employee.cnic ?? null), masked: !!clean(employee.cnic) });
    if (p && "passportNumber" in p) ident.push({ key: "passportNumber", label: "Passport number", value: show(p.passportNumber ?? null), masked: !!clean(p.passportNumber) });
    ident.push({ key: "passportExpiry", label: "Passport expiry", value: show(formatDay(s.passportExpiry)) });
    if (p && "ntn" in p) ident.push({ key: "ntn", label: "NTN", value: show(p.ntn ?? null), masked: !!clean(p.ntn) });
  } else {
    ident.push({ key: "passportExpiry", label: "Passport expiry", value: show(formatDay(s.passportExpiry)) });
  }
  if (s.nationalIdType) ident.unshift({ key: "nationalIdType", label: "Primary ID type", value: NATIONAL_ID_LABELS[s.nationalIdType] ?? titleCase(s.nationalIdType) });

  return [
    {
      key: "name",
      title: "Name",
      rows: [
        { key: "firstName", label: "First name", value: show(s.firstName) },
        { key: "middleName", label: "Middle name", value: show(s.middleName) },
        { key: "lastName", label: "Last name", value: show(s.lastName) },
        { key: "preferredName", label: "Known as", value: show(s.preferredName) },
        { key: "title", label: "Title", value: show(s.title) },
        { key: "initials", label: "Initials", value: show(initialsOf(s.firstName, s.middleName, s.lastName)) },
      ],
    },
    { key: "birth", title: "Birth data", rows: birth },
    {
      key: "marital",
      title: "Marital status",
      rows: [
        { key: "maritalStatus", label: "Marital status", value: s.maritalStatus ? titleCase(s.maritalStatus) : "—" },
        { key: "maritalStatusDate", label: "Marital status since", value: show(formatDay(s.maritalStatusDate)) },
      ],
    },
    { key: "identification", title: "Identification", rows: ident },
  ];
}

/** How complete the record is, for the "x of y filled in" hint. Counts only rows that can be filled in. */
export function completeness(groups: PersonalGroup[]): { filled: number; total: number } {
  const rows = groups.flatMap((g) => g.rows).filter((r) => r.key !== "initials" && r.key !== "nationalIdType");
  return { filled: rows.filter((r) => r.value !== "—").length, total: rows.length };
}
