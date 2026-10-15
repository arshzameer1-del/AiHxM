import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";

export type RehireBlock = {
  eligibility: "not_eligible" | "conditional";
  note: string | null;
  offboardingId: string;
};

/**
 * LIF-06: the most recent COMPLETED offboarding of any employment of this
 * person decides rehire eligibility. 'eligible' / no record -> null (no
 * restriction). Callers decide what to do with 'conditional' (allowed, but
 * audited) and 'not_eligible' (blocked unless HR gives an override reason).
 */
export async function findRehireBlock(client: PoolClient, companyId: string, personId: string): Promise<RehireBlock | null> {
  const r = await client.query<{ id: string; rehire_eligibility: "not_eligible" | "conditional"; rehire_eligibility_note: string | null }>(
    `SELECT o.id, o.rehire_eligibility, o.rehire_eligibility_note
       FROM employee_offboarding o JOIN employees e ON e.id = o.employee_id
      WHERE o.company_id = $1 AND e.person_id = $2 AND o.status = 'completed' AND o.rehire_eligibility IS NOT NULL
      ORDER BY o.completed_at DESC NULLS LAST, o.started_at DESC LIMIT 1`,
    [companyId, personId]
  );
  const row = r.rows[0];
  if (!row || (row.rehire_eligibility !== "not_eligible" && row.rehire_eligibility !== "conditional")) return null;
  return { eligibility: row.rehire_eligibility, note: row.rehire_eligibility_note, offboardingId: row.id };
}

/** Throws for 'not_eligible' unless an override reason is given. Returns the block (if any) so callers can audit it. */
export async function assertRehireAllowed(
  client: PoolClient,
  companyId: string,
  personId: string,
  overrideReason?: string | null
): Promise<RehireBlock | null> {
  const block = await findRehireBlock(client, companyId, personId);
  if (block?.eligibility === "not_eligible" && !overrideReason?.trim()) {
    throw new BadRequestException(
      `This person was marked not eligible for rehire at their last exit${block.note ? ` (${block.note})` : ""}. HR can proceed only by giving a rehireOverrideReason, which is recorded in the audit log.`
    );
  }
  return block;
}
