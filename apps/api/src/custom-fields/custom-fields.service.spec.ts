import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { CustomFieldsService } from "./custom-fields.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "custom-fields-spec-fixtures" };

describe("CustomFieldsService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let customFields: CustomFieldsService;
  let companyId: string;
  let adminUserId: string;
  let outsiderUserId: string;
  let adminClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    customFields = new CustomFieldsService(db, new RbacService(db));

    const stamp = Date.now();
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Custom Field Spec Co ${stamp}`,
        `custom-field-spec-${stamp}`,
      ]);
      companyId = company.rows[0].id;

      const admin = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`cf-admin-${stamp}@example.com`]
      );
      adminUserId = admin.rows[0].id;
      const outsider = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`cf-outsider-${stamp}@example.com`]
      );
      outsiderUserId = outsider.rows[0].id;

      const role = await client.query("SELECT id FROM roles WHERE key = 'rbac_demo_full_access'");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [adminUserId, companyId, role.rows[0].id]
      );
    });

    adminClaims = { is_platform_admin: false, company_id: companyId, sub: adminUserId };
    outsiderClaims = { is_platform_admin: false, company_id: companyId, sub: outsiderUserId };
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      await client.query("DELETE FROM user_accounts WHERE id = ANY($1::uuid[])", [[adminUserId, outsiderUserId]]);
    });
    await pool.end();
  });

  it("denies defining a field without the manage permission", async () => {
    await expect(
      customFields.defineField(outsiderClaims, {
        objectKey: "dummy_record",
        fieldKey: "shirtSize",
        label: "Shirt Size",
        fieldType: "text",
      })
    ).rejects.toThrow();
  });

  it("defines a select field, then rejects a value outside its options", async () => {
    await customFields.defineField(adminClaims, {
      objectKey: "dummy_record",
      fieldKey: "shirtSize",
      label: "Shirt Size",
      fieldType: "select",
      options: ["S", "M", "L"],
      isRequired: true,
    });

    await expect(
      customFields.setValue(adminClaims, { objectKey: "dummy_record", recordId: crypto.randomUUID(), fieldKey: "shirtSize", value: "XL" })
    ).rejects.toThrow();
  });

  it("stores and reads back a valid value, isolated per record", async () => {
    await customFields.defineField(adminClaims, {
      objectKey: "dummy_record",
      fieldKey: "shirtSize",
      label: "Shirt Size",
      fieldType: "select",
      options: ["S", "M", "L"],
    });

    const recordA = crypto.randomUUID();
    const recordB = crypto.randomUUID();
    await customFields.setValue(adminClaims, { objectKey: "dummy_record", recordId: recordA, fieldKey: "shirtSize", value: "M" });

    expect(await customFields.getValues(adminClaims, "dummy_record", recordA)).toEqual({ shirtSize: "M" });
    expect(await customFields.getValues(adminClaims, "dummy_record", recordB)).toEqual({});
  });

  it("rejects a value on an undefined field", async () => {
    await expect(
      customFields.setValue(adminClaims, { objectKey: "dummy_record", recordId: crypto.randomUUID(), fieldKey: "doesNotExist", value: "x" })
    ).rejects.toThrow();
  });
});
