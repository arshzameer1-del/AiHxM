import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmployeeDisciplinaryRecordView } from "@aihxm/shared-types";
import { disciplinaryProblem, levelLabel, medicalIsEmpty, typeLabel, waitingForAcknowledgement } from "./sensitiveRecords";

const rec = (over: Partial<EmployeeDisciplinaryRecordView>): EmployeeDisciplinaryRecordView => ({
  id: "1", employeeId: "e", recordType: "written_warning", subject: "s", description: "d", incidentDate: null, issuedDate: "2026-10-01",
  actionTaken: null, status: "active", withdrawnReason: null, withdrawnAt: null, issuedByName: null, acknowledgedAt: null, employeeComment: null,
  createdAt: "2026-10-01T00:00:00Z", ...over,
});

test("labels read as words", () => {
  assert.equal(levelLabel("fluent"), "Fluent");
  assert.equal(typeLabel("show_cause"), "Show-cause notice");
});

test("a record is waiting for the person only while it is active and unacknowledged", () => {
  const list = [rec({ id: "a" }), rec({ id: "b", acknowledgedAt: "2026-10-02T00:00:00Z" }), rec({ id: "c", status: "withdrawn", withdrawnAt: "2026-10-03T00:00:00Z" })];
  assert.deepEqual(waitingForAcknowledgement(list).map((r) => r.id), ["a"]);
});

test("the issue form says what is wrong in plain words", () => {
  assert.match(disciplinaryProblem({ subject: "", description: "x", incidentDate: "", issuedDate: "" })!, /subject/);
  assert.match(disciplinaryProblem({ subject: "Late", description: "", incidentDate: "", issuedDate: "" })!, /Describe/);
  assert.match(disciplinaryProblem({ subject: "Late", description: "Six days", incidentDate: "2026-10-05", issuedDate: "2026-10-01" })!, /after/);
  assert.equal(disciplinaryProblem({ subject: "Late", description: "Six days", incidentDate: "2026-09-05", issuedDate: "2026-10-01" }), null);
});

test("medical information counts as empty until something is entered", () => {
  const blank = { bloodGroup: null, allergies: null, chronicConditions: null, disabilityNote: null, emergencyMedicalNote: null };
  assert.equal(medicalIsEmpty(blank), true);
  assert.equal(medicalIsEmpty({ ...blank, bloodGroup: "O+" }), false);
});
