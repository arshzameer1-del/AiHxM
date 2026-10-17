import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { sensitive } from "../../crypto/sensitive-fields";

/**
 * UIFIELDS: the extra Personal Identity answers a hire can carry beyond the first six (name parts, title, nationality, language,
 * place of birth, passport, NTN). `EmployeesService.createWithinTransaction` only takes the six it always did, so these are written
 * onto the person record right after, in the same transaction. Blank answers never overwrite existing person data (a rehire keeps what
 * is already there). Passport number and NTN are encrypted the same way the Person API does.
 */
const TEXT_COLUMNS: Record<string, string> = {
  middleName: "middle_name",
  preferredName: "preferred_name",
  title: "title",
  nationality: "nationality",
  language: "language",
  placeOfBirth: "place_of_birth",
};

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

export async function applyPersonExtras(client: PoolClient, companyId: string, personId: string, personal: Record<string, unknown>): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [personId];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  for (const [key, column] of Object.entries(TEXT_COLUMNS)) {
    const v = clean(personal[key]);
    if (v === undefined) continue;
    if (key === "nationality") {
      const any = await client.query("SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = 'nationality' AND is_active LIMIT 1", [companyId]);
      if ((any.rowCount ?? 0) > 0) {
        const hit = await client.query(
          "SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = 'nationality' AND is_active AND (code = $2 OR lower(label) = lower($2))",
          [companyId, v]
        );
        if (hit.rowCount === 0) throw new BadRequestException(`nationality "${v}" is not an active nationality catalog item`);
      }
    }
    add(column, v);
  }

  const passport = clean(personal.passportNumber);
  if (passport !== undefined) add("passport_number", sensitive.encrypt(companyId, passport));
  const ntn = clean(personal.ntn);
  if (ntn !== undefined) add("ntn", sensitive.encrypt(companyId, ntn));
  const expiry = clean(personal.passportExpiry);
  if (expiry !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new BadRequestException("passportExpiry must be a date (YYYY-MM-DD)");
    add("passport_expiry", expiry, "::date");
  }

  if (sets.length === 0) return false;
  await client.query(`UPDATE persons SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  return true;
}
