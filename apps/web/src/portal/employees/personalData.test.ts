import test from "node:test";
import assert from "node:assert/strict";
import type { EmployeeView, MyPersonalDataView, PersonVersionView, PersonView } from "@aihxm/shared-types";
import { buildGroups, buildSlices, completeness, initialsOf, maskId, sliceTitle } from "./personalData";

const employee = {
  id: "e1", firstName: "Ayesha", lastName: "Khan", gender: "female", maritalStatus: "single", dateOfJoining: "2024-03-01",
  cnic: "35202-1234567-1", dateOfBirth: "1996-05-14",
} as unknown as EmployeeView;

const person = {
  id: "p1", companyId: "c", fullName: "Ayesha Bibi Khan", firstName: "Ayesha", middleName: "Bibi", lastName: "Khan", preferredName: "Aisha",
  title: "Ms", gender: "female", nationality: "Pakistani", secondNationality: null, language: "Urdu", maritalStatus: "married",
  maritalStatusDate: "2025-12-20", placeOfBirth: "Lahore", nationalIdType: "cnic", passportExpiry: "2031-01-09", createdAt: "", updatedAt: "",
  passportNumber: "AB1234567", ntn: "1234567-8",
} as PersonView;

const version = (id: string, validFrom: string, validTo: string | null, over: Partial<PersonVersionView> = {}): PersonVersionView => ({
  id, personId: "p1", validFrom, validTo, fullName: "Ayesha Khan", firstName: "Ayesha", middleName: null, lastName: "Khan", preferredName: null,
  title: null, gender: "female", nationality: "Pakistani", secondNationality: null, language: "Urdu", maritalStatus: "single", maritalStatusDate: null,
  placeOfBirth: "Lahore", nationalIdType: "cnic", passportExpiry: null, recordedAt: "", ...over,
});

const data: MyPersonalDataView = {
  employeeId: "e1",
  person,
  history: [version("v1", "2024-03-01", "2025-12-19"), version("v2", "2025-12-20", null, { maritalStatus: "married", maritalStatusDate: "2025-12-20", middleName: "Bibi", preferredName: "Aisha", title: "Ms", passportExpiry: "2031-01-09" })],
};

const value = (groups: ReturnType<typeof buildGroups>, key: string) => groups.flatMap((g) => g.rows).find((r) => r.key === key)?.value;

test("initials and masking", () => {
  assert.equal(initialsOf("Ayesha", "bibi", "Khan"), "A. B. K.");
  assert.equal(initialsOf("Ali", null, ""), "A.");
  assert.equal(maskId("35202-1234567-1"), "•••••••• 67-1");
  assert.equal(maskId("1234"), "1234");
});

test("slices are newest first and only the open one is current", () => {
  const slices = buildSlices(data, employee, "2026-10-17");
  assert.deepEqual(slices.map((s) => s.key), ["v2", "v1"]);
  assert.deepEqual(slices.map((s) => s.current), [true, false]);
  assert.equal(sliceTitle(slices[0]), "Valid from 20 Dec 2025");
  assert.equal(sliceTitle(slices[1]), "Valid 1 Mar 2024 – 19 Dec 2025");
});

test("a change dated in the future is upcoming and the record in force today stays current", () => {
  const slices = buildSlices(data, employee, "2025-06-01");
  assert.deepEqual(slices.map((s) => [s.key, s.current, s.upcoming]), [["v2", false, true], ["v1", true, false]]);
  assert.equal(sliceTitle(slices[0]), "Valid from 20 Dec 2025");
});

test("the current slice shows everything the caller may see, with the marital date", () => {
  const [current] = buildSlices(data, employee, "2026-10-17");
  const groups = buildGroups(current, employee, data);
  assert.deepEqual(groups.map((g) => g.title), ["Name", "Birth data", "Marital status", "Identification"]);
  assert.equal(value(groups, "maritalStatus"), "Married");
  assert.equal(value(groups, "maritalStatusDate"), "20 Dec 2025");
  assert.equal(value(groups, "dateOfBirth"), "14 May 1996");
  assert.equal(value(groups, "cnic"), "35202-1234567-1");
  assert.equal(groups.flatMap((g) => g.rows).find((r) => r.key === "cnic")?.masked, true);
  assert.equal(value(groups, "initials"), "A. B. K.");
  assert.equal(value(groups, "preferredName"), "Aisha");
});

test("an earlier slice shows what was true then and leaves out undated ID numbers", () => {
  const old = buildSlices(data, employee, "2026-10-17")[1];
  const groups = buildGroups(old, employee, data);
  assert.equal(value(groups, "maritalStatus"), "Single");
  assert.equal(value(groups, "maritalStatusDate"), "—");
  assert.equal(value(groups, "cnic"), undefined);
  assert.equal(value(groups, "passportNumber"), undefined);
  assert.equal(value(groups, "dateOfBirth"), undefined);
});

test("a field the caller may not see is left out, not shown as a dash", () => {
  const hidden = { ...employee } as Record<string, unknown>;
  delete hidden.cnic;
  delete hidden.dateOfBirth;
  const groups = buildGroups(buildSlices(data, hidden as unknown as EmployeeView)[0], hidden as unknown as EmployeeView, data);
  assert.equal(value(groups, "cnic"), undefined);
  assert.equal(value(groups, "dateOfBirth"), undefined);
});

test("with no person record yet it falls back to the employee record", () => {
  const slices = buildSlices(null, employee);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].current, true);
  const groups = buildGroups(slices[0], employee, null);
  assert.equal(value(groups, "firstName"), "Ayesha");
  assert.equal(value(groups, "gender"), "Female");
  assert.equal(value(groups, "nationality"), "—");
  assert.equal(value(groups, "passportNumber"), undefined);
});

test("completeness counts filled rows", () => {
  const groups = buildGroups(buildSlices(data, employee, "2026-10-17")[0], employee, data);
  const c = completeness(groups);
  assert.ok(c.total > 10);
  assert.ok(c.filled >= c.total - 2);
});
