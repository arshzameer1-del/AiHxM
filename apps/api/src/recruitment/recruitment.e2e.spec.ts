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

/**
 * Phase 10's exit criterion, verified the same extra way Phase 9's was:
 * real HTTP through the actual guards/controllers/`ValidationPipe`
 * stack, on top of the service-level tests in
 * recruitment.service.spec.ts — a full requisition -> approval ->
 * candidate -> pipeline -> offer -> hire round trip.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "recruitment-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Recruitment HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;

  let companyId: string;
  let hrAdminToken: string;
  let approverToken: string;

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
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Recruitment E2E Co ${stamp}`,
        `recruitment-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "recruitment"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'recruitment', true)",
        [id]
      );
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

    const hrAdminUserId = await makeUser(`recruitment-e2e-hr-${stamp}@example.com`);
    const hrAdminRoleId = await assignRole(hrAdminUserId, "hr_admin");
    await assignRole(hrAdminUserId, "rbac_demo_full_access");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const approverUserId = await makeUser(`recruitment-e2e-approver-${stamp}@example.com`);
    await assignRole(approverUserId, "hr_admin");
    approverToken = signSession({ sub: approverUserId, is_platform_admin: false, company_id: companyId });

    const hrAdminClaims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: hrAdminUserId };
    await workflow.createTemplate(hrAdminClaims, {
      key: "job_requisition",
      name: "Requisition Approval",
      objectKey: "job_requisition",
      steps: [{ stepOrder: 1, name: "HR Admin approves", approvers: [{ approverType: "role", roleId: hrAdminRoleId }] }],
    });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("real HTTP round trip: requisition -> approval -> candidate -> pipeline -> offer -> hire", async () => {
    const requisitionResponse = await request(app.getHttpServer())
      .post("/job-requisitions")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ title: "QA Engineer", department: "Engineering", salaryBand: "E2" })
      .expect(201);
    const requisitionId = requisitionResponse.body.id;
    expect(requisitionResponse.body.status).toBe("draft");

    await request(app.getHttpServer())
      .post(`/job-requisitions/${requisitionId}/submit`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(201);

    const decideResponse = await request(app.getHttpServer())
      .patch(`/job-requisitions/${requisitionId}/decision`)
      .set("Authorization", `Bearer ${approverToken}`)
      .send({ decision: "approved" })
      .expect(200);
    expect(decideResponse.body.status).toBe("approved");

    const candidateResponse = await request(app.getHttpServer())
      .post("/candidates")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ firstName: "Hina", lastName: "Applicant", email: `hina-${Date.now()}@example.com` })
      .expect(201);
    const candidateId = candidateResponse.body.id;

    const applicationResponse = await request(app.getHttpServer())
      .post("/applications")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ requisitionId, candidateId })
      .expect(201);
    const applicationId = applicationResponse.body.id;
    expect(applicationResponse.body.stage).toBe("applied");

    await request(app.getHttpServer())
      .patch(`/applications/${applicationId}/stage`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ stage: "screening" })
      .expect(200);

    // Direct jump to 'hired' is refused by the service, not just a UI convention.
    await request(app.getHttpServer())
      .patch(`/applications/${applicationId}/stage`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ stage: "hired" })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/applications/${applicationId}/stage`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ stage: "interview" })
      .expect(200);

    const offerResponse = await request(app.getHttpServer())
      .post("/offers")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ applicationId, salary: 180000, startDate: "2026-11-20" })
      .expect(201);
    const offerId = offerResponse.body.id;

    const acceptResponse = await request(app.getHttpServer())
      .patch(`/offers/${offerId}/decision`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ decision: "accepted" })
      .expect(200);

    expect(acceptResponse.body.offer.status).toBe("accepted");
    expect(acceptResponse.body.employee).not.toBeNull();
    expect(acceptResponse.body.employee.firstName).toBe("Hina");
    expect(acceptResponse.body.employee.employeeNumber).toMatch(/^EMP-/);
  });
});
