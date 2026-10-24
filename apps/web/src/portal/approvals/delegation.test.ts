import assert from "node:assert/strict";
import { test } from "node:test";
import { delegationState } from "./delegation";

test("a cover arrangement is active, upcoming, ended or cancelled", () => {
  const d = (status: "active" | "revoked", validFrom: string, validTo: string) => ({ status, validFrom, validTo });
  assert.equal(delegationState(d("active", "2026-10-20", "2026-10-30"), "2026-10-24"), "active");
  assert.equal(delegationState(d("active", "2026-10-24", "2026-10-24"), "2026-10-24"), "active");
  assert.equal(delegationState(d("active", "2026-10-25", "2026-10-30"), "2026-10-24"), "upcoming");
  assert.equal(delegationState(d("active", "2026-10-01", "2026-10-23"), "2026-10-24"), "ended");
  assert.equal(delegationState(d("revoked", "2026-10-20", "2026-10-30"), "2026-10-24"), "revoked");
});
