import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryState, typeLabel, uploadProblem, DEFAULT_DOCUMENT_TYPES } from "./employeeDocuments";

test("expiryState: none, expired, soon (within 60 days), ok", () => {
  assert.equal(expiryState(null, "2026-10-24"), "none");
  assert.equal(expiryState("2026-10-23", "2026-10-24"), "expired");
  assert.equal(expiryState("2026-10-24", "2026-10-24"), "soon");
  assert.equal(expiryState("2026-12-23", "2026-10-24"), "soon");
  assert.equal(expiryState("2026-12-24", "2026-10-24"), "ok");
  assert.equal(expiryState("2026-10-30T00:00:00.000Z", "2026-10-24"), "soon");
});

test("typeLabel uses the catalog label and falls back to a readable code", () => {
  assert.equal(typeLabel("cnic", DEFAULT_DOCUMENT_TYPES), "CNIC");
  assert.equal(typeLabel("work_permit", DEFAULT_DOCUMENT_TYPES), "work permit");
});

test("uploadProblem catches a missing, huge, wrong-type or non-image photo before sending", () => {
  assert.match(uploadProblem(null, "cnic") ?? "", /Choose a file/);
  assert.match(uploadProblem({ size: 11 * 1024 * 1024, type: "application/pdf" }, "cnic") ?? "", /10 MB/);
  assert.match(uploadProblem({ size: 10, type: "application/zip" }, "cnic") ?? "", /PDF, JPEG/);
  assert.match(uploadProblem({ size: 10, type: "application/pdf" }, "photograph") ?? "", /image/);
  assert.equal(uploadProblem({ size: 10, type: "image/png" }, "photograph"), null);
  assert.equal(uploadProblem({ size: 10, type: "application/pdf" }, "cnic"), null);
});
