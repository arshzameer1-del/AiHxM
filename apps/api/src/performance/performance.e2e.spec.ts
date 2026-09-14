import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

/**
 * Phase 11's exit criterion, verified the same extra way every prior
 * phase's was: real HTTP through the actual guards/controllers/
 * `ValidationPipe` stack — a full self-assessment-to-final-rating round
 * trip.
 */
const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "performance-e2e-fixtures" };

function signSession(payload: { sub: string; is_platform_admin: boolean; company_id: string | null }): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "10m" });
}

describe("Performance HTTP surface (e2e)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;

  let companyId: string;
  let hrAdminToken: string;
  let managerToken: string;
  let staffToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);

    const stamp = Date.now();
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Performance E2E Co ${stamp}`,
        `performance-e2e-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee", "performance"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query(
        "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true), ($1, 'performance', true)",
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
    async function assignRole(userAccountId: string, roleKey: string): Promise<void> {
      await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query(
          "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)",
          [userAccountId, companyId, role.rows[0].id]
        );
      });
    }
    async function makeEmployee(input: { firstName: string; lastName: string; userAccountId: string; managerId?: string }): Promise<string> {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, department, manager_id)
           VALUES ($1, $2, $3, $4, $5, 'Engineering', $6) RETURNING id`,
          [companyId, input.userAccountId, `EMP-${Math.floor(Math.random() * 100000)}`, input.firstName, input.lastName, input.managerId ?? null]
        );
        return result.rows[0].id as string;
      });
    }

    const hrAdminUserId = await makeUser(`perf-e2e-hr-${stamp}@example.com`);
    await assignRole(hrAdminUserId, "hr_admin");
    hrAdminToken = signSession({ sub: hrAdminUserId, is_platform_admin: false, company_id: companyId });

    const managerUserId = await makeUser(`perf-e2e-mgr-${stamp}@example.com`);
    await assignRole(managerUserId, "line_manager");
    await assignRole(managerUserId, "employee_self_service");
    managerToken = signSession({ sub: managerUserId, is_platform_admin: false, company_id: companyId });

    const staffUserId = await makeUser(`perf-e2e-staff-${stamp}@example.com`);
    await assignRole(staffUserId, "employee_self_service");
    staffToken = signSession({ sub: staffUserId, is_platform_admin: false, company_id: companyId });

    const managerEmployeeId = await makeEmployee({ firstName: "Mona", lastName: "Manager", userAccountId: managerUserId });
    await makeEmployee({ firstName: "Sami", lastName: "Staff", userAccountId: staffUserId, managerId: managerEmployeeId });
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) => client.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("real HTTP round trip: create -> launch -> self-assessment -> manager-assessment -> calibrate -> close -> released final rating", async () => {
    const cycleResponse = await request(app.getHttpServer())
      .post("/review-cycles")
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ name: "H2 2026 Review", periodStart: "2026-07-01", periodEnd: "2026-12-31" })
      .expect(201);
    const cycleId = cycleResponse.body.id;
    expect(cycleResponse.body.status).toBe("draft");

    const launchResponse = await request(app.getHttpServer())
      .post(`/review-cycles/${cycleId}/launch`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(201);
    expect(launchResponse.body.participantCount).toBe(2);

    const reviewsResponse = await request(app.getHttpServer())
      .get(`/performance-reviews?reviewCycleId=${cycleId}`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(200);
    // Resolve which of the two reviews actually belongs to the staff
    // employee before asserting on it, rather than assuming row order.
    let staffReviewId: string | null = null;
    for (const review of reviewsResponse.body) {
      const asStaff = await request(app.getHttpServer())
        .get(`/performance-reviews/${review.id}`)
        .set("Authorization", `Bearer ${staffToken}`);
      if (asStaff.status === 200) staffReviewId = review.id;
    }
    expect(staffReviewId).not.toBeNull();

    const selfSubmit = await request(app.getHttpServer())
      .patch(`/performance-reviews/${staffReviewId}/self-assessment`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ selfAssessment: "Delivered the release on time, mentored a new hire." })
      .expect(200);
    expect(selfSubmit.body.status).toBe("in_progress");

    const managerSubmit = await request(app.getHttpServer())
      .patch(`/performance-reviews/${staffReviewId}/manager-assessment`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ managerAssessment: "Reliable delivery, great mentoring.", managerRating: 4 })
      .expect(200);
    expect(managerSubmit.body.status).toBe("completed");

    // Not visible to the employee yet.
    const preReleaseView = await request(app.getHttpServer())
      .get(`/performance-reviews/${staffReviewId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    expect(preReleaseView.body.finalRating).toBeUndefined();

    const distribution = await request(app.getHttpServer())
      .get(`/review-cycles/${cycleId}/rating-distribution`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(200);
    expect(distribution.body.distribution["4"]).toBe(1);

    await request(app.getHttpServer())
      .patch(`/performance-reviews/${staffReviewId}/calibrate`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .send({ calibrationRating: 5, calibrationComment: "Bumped after peer calibration." })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/review-cycles/${cycleId}/begin-calibration`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(201);

    const closeResponse = await request(app.getHttpServer())
      .post(`/review-cycles/${cycleId}/close`)
      .set("Authorization", `Bearer ${hrAdminToken}`)
      .expect(201);
    expect(closeResponse.body.releasedCount).toBeGreaterThanOrEqual(1);

    const postReleaseView = await request(app.getHttpServer())
      .get(`/performance-reviews/${staffReviewId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    expect(postReleaseView.body.status).toBe("released");
    expect(postReleaseView.body.finalRating).toBe(5);

    // A ValidationPipe rejection (400) for an out-of-range rating, before
    // it ever reaches the service — the same discipline every prior
    // phase's e2e test has proven at least once.
    await request(app.getHttpServer())
      .patch(`/performance-reviews/${staffReviewId}/manager-assessment`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ managerAssessment: "x", managerRating: 9 })
      .expect(400);
  });
});
