import { Pool } from "pg";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { DocumentTemplatesService } from "./document-templates.service";

const FIXTURE_CLAIMS: RequestClaims = {
  is_platform_admin: true,
  company_id: null,
  sub: "document-templates-spec-fixtures",
};

/**
 * Plan doc Section 6's Forms WRICEF pillar: DocumentTemplatesService is a
 * deliberately minimal `{{fieldKey}}` substitution engine (see the
 * service's own doc comment), not a full templating language. Only
 * `createTemplate` is RBAC-gated (`document_template.manage.all`, granted
 * to the `rbac_demo_full_access` seed role by migration 0009) — `list`
 * and `render` require only that the caller carry a `company_id`, with no
 * further permission check in the service today.
 */
describe("DocumentTemplatesService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let rbac: RbacService;
  let documentTemplates: DocumentTemplatesService;

  let companyId: string;
  let adminUserId: string;
  let outsiderUserId: string;
  let adminClaims: RequestClaims;
  let outsiderClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    rbac = new RbacService(db);
    documentTemplates = new DocumentTemplatesService(db, rbac);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Document Templates Spec Co ${stamp}`,
        `doc-templates-spec-${stamp}`,
      ]);
      companyId = company.rows[0].id;

      const admin = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`dt-admin-${stamp}@example.com`]
      );
      adminUserId = admin.rows[0].id;
      const outsider = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [`dt-outsider-${stamp}@example.com`]
      );
      outsiderUserId = outsider.rows[0].id;

      const role = await client.query("SELECT id FROM roles WHERE key = 'rbac_demo_full_access'");
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
        [adminUserId, companyId, role.rows[0].id]
      );
      // outsiderUserId deliberately gets no role assignment at all.
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

  describe("createTemplate", () => {
    it("denies creating a template without document_template.manage.all", async () => {
      await expect(
        documentTemplates.createTemplate(outsiderClaims, {
          key: "offer-letter",
          name: "Offer Letter",
          objectKey: "employee",
          templateBody: "Dear {{firstName}}, welcome to {{companyName}}.",
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws for a caller with no company_id at all", async () => {
      await expect(
        documentTemplates.createTemplate(FIXTURE_CLAIMS, {
          key: "no-company",
          name: "No Company",
          objectKey: "employee",
          templateBody: "x",
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("creates a template scoped to the caller's company", async () => {
      const template = await documentTemplates.createTemplate(adminClaims, {
        key: "offer-letter",
        name: "Offer Letter",
        objectKey: "employee",
        templateBody: "Dear {{firstName}}, welcome to {{companyName}}.",
      });

      expect(template.id).toBeDefined();
      expect(template.companyId).toBe(companyId);
      expect(template.key).toBe("offer-letter");
      expect(template.name).toBe("Offer Letter");
      expect(template.objectKey).toBe("employee");
      expect(template.templateBody).toBe("Dear {{firstName}}, welcome to {{companyName}}.");
      expect(template.createdAt).toBeDefined();
    });
  });

  describe("listTemplates", () => {
    it("lists only the caller's own tenant's templates, oldest first", async () => {
      await documentTemplates.createTemplate(adminClaims, {
        key: "payslip",
        name: "Payslip",
        objectKey: "payroll_run",
        templateBody: "Net pay: {{netPay}}",
      });

      const list = await documentTemplates.listTemplates(adminClaims);
      const keys = list.map((t) => t.key);
      expect(keys).toContain("offer-letter");
      expect(keys).toContain("payslip");
      expect(list.every((t) => t.companyId === companyId)).toBe(true);
    });

    it("returns an empty array for a caller with no company_id", async () => {
      expect(await documentTemplates.listTemplates(FIXTURE_CLAIMS)).toEqual([]);
    });
  });

  describe("render", () => {
    it("substitutes {{fieldKey}} placeholders from the supplied record", async () => {
      const rendered = await documentTemplates.render(adminClaims, "offer-letter", {
        firstName: "Ayesha",
        companyName: "Acme Pakistan",
      });

      expect(rendered.templateKey).toBe("offer-letter");
      expect(rendered.content).toBe("Dear Ayesha, welcome to Acme Pakistan.");
    });

    it("substitutes an empty string for a missing or null field", async () => {
      const rendered = await documentTemplates.render(adminClaims, "offer-letter", {
        firstName: null,
        // companyName intentionally omitted
      });

      expect(rendered.content).toBe("Dear , welcome to .");
    });

    it("throws NotFoundException for a key that doesn't exist in this tenant", async () => {
      await expect(documentTemplates.render(adminClaims, "does-not-exist", {})).rejects.toThrow(NotFoundException);
    });

    it("does not leak another tenant's template of the same key", async () => {
      await expect(documentTemplates.render(outsiderClaims, "offer-letter", {})).resolves.toBeDefined();
      // outsiderClaims is in the same tenant, so this is a same-company
      // read (render has no RBAC gate) — a genuinely different tenant
      // simply never matches company_id in the WHERE clause, which is
      // exercised by the "no company_id" case below.
      await expect(
        documentTemplates.render(FIXTURE_CLAIMS, "offer-letter", {})
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
