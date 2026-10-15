import { Pool } from "pg";
import { randomUUID } from "crypto";

/**
 * Gap Register INT-02 — migration 0122. Runs as the table owner so the
 * assertions exercise the triggers themselves, independent of RLS.
 */
describe("polymorphic reference integrity (0122)", () => {
  let owner: Pool;
  let companyA: string;
  let companyB: string;
  let orgUnitA: string;
  let orgUnitB: string;
  let employeeA: string;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    const stamp = Date.now();
    const mkCompany = async (n: string) =>
      (await owner.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Poly ${n} ${stamp}`, `poly-${n}-${stamp}`])).rows[0].id as string;
    companyA = await mkCompany("a");
    companyB = await mkCompany("b");
    const mkUnit = async (company: string, n: string) =>
      (await owner.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id", [company, `Unit ${n} ${stamp}`])).rows[0].id as string;
    orgUnitA = await mkUnit(companyA, "a");
    orgUnitB = await mkUnit(companyB, "b");
    employeeA = (
      await owner.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1,'POLY-1','Poly','Tester') RETURNING id",
        [companyA]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await owner.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyA, companyB]]);
    await owner.end();
  });

  const mapping = (company: string, scopeType: string, scopeValue: string) =>
    owner.query(
      "INSERT INTO configuration_rule_mappings (company_id, config_domain, config_key, scope_type, scope_value, rule_value) VALUES ($1,'leave','k',$2,$3,'{}'::jsonb)",
      [company, scopeType, scopeValue]
    );

  it("accepts a real same-company org unit and employee", async () => {
    await mapping(companyA, "org_unit", orgUnitA);
    await mapping(companyA, "employee", employeeA);
  });

  it("rejects a nonexistent id", async () => {
    await expect(mapping(companyA, "org_unit", randomUUID())).rejects.toThrow(/does not exist in this company/);
  });

  it("rejects another tenant's entity (cross-tenant reference)", async () => {
    await expect(mapping(companyA, "org_unit", orgUnitB)).rejects.toThrow(/does not exist in this company/);
  });

  it("rejects a non-uuid value for a verifiable scope type", async () => {
    await expect(mapping(companyA, "location", "HEAD-OFFICE")).rejects.toThrow(/expected an id/);
  });

  it("validates data_scope_assignments and payroll_area_scope_links the same way", async () => {
    await expect(
      owner.query("INSERT INTO payroll_area_scope_links (company_id, payroll_area_id, scope_type, scope_entity_id) VALUES ($1,$2,'org_unit',$3)", [
        companyA,
        randomUUID(),
        randomUUID(),
      ])
    ).rejects.toThrow(/does not exist in this company|violates foreign key/);
    await expect(
      owner.query("INSERT INTO data_scope_assignments (user_account_id, company_id, scope_type, scope_entity_id) VALUES ($1,$2,'cost_center',$3)", [
        randomUUID(),
        companyA,
        randomUUID(),
      ])
    ).rejects.toThrow(/does not exist in this company|violates foreign key/);
  });

  it("verifies custom_field_values.record_id for known object keys and allows unknown ones", async () => {
    await expect(
      owner.query("INSERT INTO custom_field_values (company_id, object_key, record_id, field_key, value) VALUES ($1,'employee',$2,'f','1'::jsonb)", [companyA, randomUUID()])
    ).rejects.toThrow(/does not exist in this company/);
    await owner.query("INSERT INTO custom_field_values (company_id, object_key, record_id, field_key, value) VALUES ($1,'employee',$2,'f','1'::jsonb)", [companyA, employeeA]);
    // an object key no module has registered yet is intentionally polymorphic
    await owner.query("INSERT INTO custom_field_values (company_id, object_key, record_id, field_key, value) VALUES ($1,'future_object',$2,'f','1'::jsonb)", [companyA, randomUUID()]);
  });

  it("never re-validates an unchanged legacy row on UPDATE", async () => {
    await owner.query("UPDATE configuration_rule_mappings SET priority = priority + 1 WHERE company_id = $1 AND scope_type = 'org_unit'", [companyA]);
    // simulate legacy bad data inserted before the trigger existed
    await owner.query("ALTER TABLE configuration_rule_mappings DISABLE TRIGGER trg_poly_ref_rule_mapping");
    try {
      await mapping(companyA, "location", "legacy-free-text");
    } finally {
      await owner.query("ALTER TABLE configuration_rule_mappings ENABLE TRIGGER trg_poly_ref_rule_mapping");
    }
    await owner.query("UPDATE configuration_rule_mappings SET is_active = false WHERE company_id = $1 AND scope_value = 'legacy-free-text'", [companyA]);
  });
});
