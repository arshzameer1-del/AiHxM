import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { WorkflowService } from "../workflow/workflow.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "org-changes-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

/**
 * Organization Management, Phase 5 — real HTTP routes
 * (org-changes.controller.ts) through the actual guards/`ValidationPipe`
 * stack, on top of the service-level tests in
 * org-changes.service.spec.ts: a full Draft -> Validate -> Impact
 * Analysis -> Approval -> Execution -> Publish round trip, the same shape
 * recruitment.e2e.spec.ts's own requisition round trip already proved for
 * a WorkflowService-backed object.
 */
describe("Reorganization Changes HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;

  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let backendUnitId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const audit = new AuditService();
    workflow = new WorkflowService(db, rbac, audit);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [
        `Reorg E2E Co ${stamp}`,
        `reorg-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [
        id,
      ]);
      return id;
    });

    async function makeUser(email: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
          email,
        ]);
        return result.rows[0].id as string;
      });
    }
    async function assignRole(userAccountId: string, roleKey: string): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
        return role.rows[0].id as string;
      });
    }

    const hrAdminUserId = await makeUser(`org-changes-e2e-hr-${stamp}@example.com`);
    const hrAdminRoleId = await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await makeUser(`org-changes-e2e-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const hrAdminClaims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    await workflow.createTemplate(hrAdminClaims, {
      key: "org_reorganization",
      name: "Reorganization Approval",
      objectKey: "org_reorganization",
      steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrAdminRoleId }] }],
    });

    const unit = await db.withClaims(hrAdminClaims, (client) =>
      client.query(
        `INSERT INTO org_units (company_id, unit_type, name, status) VALUES ($1, 'department', 'Backend', 'active') RETURNING id`,
        [companyId]
      )
    );
    backendUnitId = unit.rows[0].id;
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("rejects without authorization", async () => {
    const res = await request(app.getHttpServer()).get("/organization/reorganizations");
    expect(res.status).toBe(401);
  });

  it("403s a Line Manager trying to draft a change (view.all only, no manage)", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/reorganizations")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ title: "Nope", effectiveDate: "2020-01-01", items: [{ orgUnitId: backendUnitId, action: "archive" }] });

    expect(res.status).toBe(403);
  });

  it("rejects an invalid item shape (unknown action) at the DTO layer", async () => {
    const res = await request(app.getHttpServer())
      .post("/organization/reorganizations")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ title: "Bad action", effectiveDate: "2020-01-01", items: [{ orgUnitId: backendUnitId, action: "teleport" }] });

    expect(res.status).toBe(400);
  });

  let changeId: string;

  it("real HTTP round trip: draft -> validate -> impact -> submit -> decide -> published", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/organization/reorganizations")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({
        title: "Rename Backend via HTTP",
        effectiveDate: "2020-01-01",
        items: [{ orgUnitId: backendUnitId, action: "rename", newName: "Platform Engineering" }],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe("draft");
    changeId = createRes.body.id;

    const validateRes = await request(app.getHttpServer())
      .post(`/organization/reorganizations/${changeId}/validate`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(validateRes.status).toBe(201);
    expect(validateRes.body.valid).toBe(true);

    const impactRes = await request(app.getHttpServer())
      .post(`/organization/reorganizations/${changeId}/impact`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(impactRes.status).toBe(201);
    expect(impactRes.body.affectedOrgUnitCount).toBeGreaterThanOrEqual(1);

    const submitRes = await request(app.getHttpServer())
      .post(`/organization/reorganizations/${changeId}/submit`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.status).toBe("pending_approval");

    const decideRes = await request(app.getHttpServer())
      .post(`/organization/reorganizations/${changeId}/decide`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ decision: "approved" });
    expect(decideRes.status).toBe(201);
    expect(decideRes.body.status).toBe("published");
    expect(decideRes.body.items[0].appliedAt).not.toBeNull();

    const unitRes = await request(app.getHttpServer())
      .get(`/organization/units/${backendUnitId}`)
      .set("Authorization", `Bearer ${hrAdminToken}`);
    expect(unitRes.body.name).toBe("Platform Engineering");
  });

  it("a Line Manager can read the published change (view.all) even though they couldn't have created it", async () => {
    const res = await request(app.getHttpServer())
      .get(`/organization/reorganizations/${changeId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
  });

  it("execute() 400s once the change is already published", async () => {
    const res = await request(app.getHttpServer())
      .post(`/organization/reorganizations/${changeId}/execute`)
      .set("Authorization", `Bearer ${hrAdminToken}`);

    expect(res.status).toBe(400);
  });
});
