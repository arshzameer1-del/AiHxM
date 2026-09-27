import { Pool } from "pg";
import { NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { CardFieldConfigService, hiringCardObjectKey } from "./card-field-config.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "card-field-config-spec-fixtures" };

/**
 * Hiring Card Field Configuration (2026-09-27) — real Postgres, no mocks,
 * the same discipline every other spec in this module already uses. Covers
 * the three things `HiringWizardPage.tsx` and a new "configure this card's
 * fields" admin page will both depend on: the lazy per-company seed of
 * built-in fields, enable/disable/required toggles, and "add custom
 * field" mirroring onto `objectKey: "employee"` per kumail's own "Wizard +
 * Employee profile" scope choice.
 */
describe("CardFieldConfigService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let cardFields: CardFieldConfigService;
  let customFields: CustomFieldsService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    customFields = new CustomFieldsService(db, rbac);
    cardFields = new CardFieldConfigService(db, rbac, entitlements, audit, customFields);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Card Field Config Spec Co ${stamp}`,
        `card-field-config-spec-co-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    const user = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`card-field-hr-${stamp}@example.com`])
    );
    const hrAdminUserId = user.rows[0].id as string;
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        hrAdminUserId,
        companyId,
        role.rows[0].id,
      ]);
    });
    hrAdminClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
  });

  afterAll(async () => {
    await pool.end();
  });

  it("seeds the built-in fields from the catalog on first read, all enabled by default", async () => {
    const view = await cardFields.listCardFields(hrAdminClaims, "personal_identity");
    expect(view.cardKey).toBe("personal_identity");
    expect(view.builtIn.map((f) => f.fieldKey)).toEqual(
      expect.arrayContaining(["firstName", "lastName", "cnic", "dateOfBirth", "gender", "maritalStatus"])
    );
    expect(view.builtIn.every((f) => f.isEnabled)).toBe(true);
    expect(view.builtIn.find((f) => f.fieldKey === "firstName")?.isRequired).toBe(true);
    expect(view.builtIn.find((f) => f.fieldKey === "gender")?.isRequired).toBe(false);
    expect(view.custom).toEqual([]);
  });

  it("disables a built-in field and makes another one required", async () => {
    const updated = await cardFields.updateFieldConfig(hrAdminClaims, "personal_identity", "maritalStatus", {
      isEnabled: false,
      isRequired: true,
    });
    expect(updated.isEnabled).toBe(false);
    expect(updated.isRequired).toBe(true);

    const reloaded = await cardFields.listCardFields(hrAdminClaims, "personal_identity");
    const maritalStatus = reloaded.builtIn.find((f) => f.fieldKey === "maritalStatus");
    expect(maritalStatus?.isEnabled).toBe(false);
    expect(maritalStatus?.isRequired).toBe(true);
    // Untouched sibling fields keep their own defaults.
    expect(reloaded.builtIn.find((f) => f.fieldKey === "firstName")?.isEnabled).toBe(true);
  });

  it("throws NotFoundException for a field key that isn't in the catalog for that card", async () => {
    await expect(cardFields.updateFieldConfig(hrAdminClaims, "personal_identity", "notARealField", { isEnabled: false })).rejects.toThrow(
      NotFoundException
    );
  });

  it("adds a custom field to a card, visible on that card AND mirrored onto the employee object", async () => {
    const defined = await cardFields.addCustomField(hrAdminClaims, "contact", {
      fieldKey: "linkedinUrl",
      label: "LinkedIn URL",
      fieldType: "text",
      isRequired: true,
    });
    expect(defined.objectKey).toBe(hiringCardObjectKey("contact"));
    expect(defined.isRequired).toBe(true);

    const cardView = await cardFields.listCardFields(hrAdminClaims, "contact");
    expect(cardView.custom.map((f) => f.fieldKey)).toContain("linkedinUrl");

    // The employee-scope mirror exists too, but is never required — kumail's
    // own scope choice was to reuse it for post-hire display, not to make
    // hiring-time requiredness bind an already-hired employee's profile.
    const employeeScoped = await customFields.listDefinitions(hrAdminClaims, "employee");
    const mirrored = employeeScoped.find((f) => f.fieldKey === "linkedinUrl");
    expect(mirrored).toBeDefined();
    expect(mirrored?.isRequired).toBe(false);
  });

  it("deactivating a custom field on one card leaves its employee-scope mirror active", async () => {
    await cardFields.addCustomField(hrAdminClaims, "assets", {
      fieldKey: "warrantyExpiry",
      label: "Warranty expiry",
      fieldType: "date",
    });

    await cardFields.deactivateCustomField(hrAdminClaims, "assets", "warrantyExpiry");

    const cardView = await cardFields.listCardFields(hrAdminClaims, "assets");
    expect(cardView.custom.map((f) => f.fieldKey)).not.toContain("warrantyExpiry");

    const employeeScoped = await customFields.listDefinitions(hrAdminClaims, "employee");
    expect(employeeScoped.map((f) => f.fieldKey)).toContain("warrantyExpiry");
  });

  it("keeps a second company's field configuration completely separate", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const otherCompanyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Card Field Config Spec Co B ${stamp}`,
        `card-field-config-spec-co-b-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    const otherUser = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`card-field-hr-b-${stamp}@example.com`])
    );
    const otherUserId = otherUser.rows[0].id as string;
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
      await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
        otherUserId,
        otherCompanyId,
        role.rows[0].id,
      ]);
    });
    const otherClaims: RequestClaims = { is_platform_admin: false, company_id: otherCompanyId, sub: otherUserId };

    // The first company disabled `maritalStatus` earlier in this file — a
    // brand-new company reading the same card for the first time must
    // still see it enabled by default (its own lazy seed, not a leaked row).
    const otherView = await cardFields.listCardFields(otherClaims, "personal_identity");
    expect(otherView.builtIn.find((f) => f.fieldKey === "maritalStatus")?.isEnabled).toBe(true);
    expect(otherView.custom).toEqual([]);
  });
});
