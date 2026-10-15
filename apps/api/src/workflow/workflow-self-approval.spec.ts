import { Pool } from "pg";
import { ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowService } from "./workflow.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "self-approval-spec-fixtures" };

/**
 * LIVE-03/14: the tenant's "Approval Controls" policy can stop a person approving their own request. Real Postgres.
 * Default (no policy) keeps the old behaviour so small companies with one admin are not locked out.
 */
describe("WorkflowService self-approval control", () => {
  let pool: Pool;
  let db: DatabaseService;
  let workflow: WorkflowService;
  let companyId: string;
  let otherCompanyId: string;
  let roleId: string;
  let a: RequestClaims; // submits and holds the approver role
  let b: RequestClaims; // second approver in the same company
  let outsiderCompanyUser: RequestClaims; // approver role in another company
  const templateKey = `selfappr-${Date.now()}`;

  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => (await client.query(text, params)).rows as T[]);
  }

  async function setPolicy(company: string, blockSelfApproval: boolean | null) {
    if (blockSelfApproval === null) {
      await sql("UPDATE hr_business_policies SET is_active = false WHERE company_id = $1 AND policy_type = 'approval_controls'", [company]);
      return;
    }
    await sql(
      `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default, is_active, sort_order)
       VALUES ($1, 'approval_controls', 'default', 'Approval Controls', $2::jsonb, true, true, 0)
       ON CONFLICT (company_id, policy_type, code) DO UPDATE SET rules = EXCLUDED.rules, is_active = true`,
      [company, JSON.stringify({ blockSelfApproval })]
    );
  }

  async function submit(claims: RequestClaims, company: string, key: string) {
    const rec = (await sql<{ id: string }>("INSERT INTO dummy_records (company_id, title, status) VALUES ($1, 'Self approval', 'locked') RETURNING id", [company]))[0].id;
    return workflow.submitForApproval(claims, { templateKey: key, objectKey: "dummy_record", recordId: rec, record: { status: "locked" } });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    workflow = new WorkflowService(db, new RbacService(db), new AuditService());
    const stamp = Date.now();
    companyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`SelfAppr ${stamp}`, `selfappr-${stamp}`]))[0].id;
    otherCompanyId = (await sql<{ id: string }>("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`SelfAppr Other ${stamp}`, `selfappr-o-${stamp}`]))[0].id;
    roleId = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'rbac_demo_view_only'"))[0].id;
    const adminRole = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'rbac_demo_full_access'"))[0].id;
    const user = async (email: string, company: string, role: string) => {
      const id = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]))[0].id;
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [id, company, role]);
      return { is_platform_admin: false, company_id: company, sub: id } as RequestClaims;
    };
    a = await user(`selfappr-a-${stamp}@example.com`, companyId, roleId);
    b = await user(`selfappr-b-${stamp}@example.com`, companyId, roleId);
    const admin = await user(`selfappr-admin-${stamp}@example.com`, companyId, adminRole);
    outsiderCompanyUser = await user(`selfappr-o-${stamp}@example.com`, otherCompanyId, roleId);
    const otherAdmin = await user(`selfappr-oadmin-${stamp}@example.com`, otherCompanyId, adminRole);
    for (const [claims, company] of [[admin, companyId], [otherAdmin, otherCompanyId]] as const) {
      await workflow.createTemplate(claims, {
        key: templateKey,
        name: "Self approval",
        objectKey: "dummy_record",
        steps: [{ stepOrder: 1, name: "Approve", approvers: [{ approverType: "role", roleId }] }],
      });
      void company;
    }
  });

  afterAll(async () => {
    await sql("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[companyId, otherCompanyId]]);
    await pool.end();
  });

  it("with no policy the submitter may approve their own request (behaviour unchanged)", async () => {
    await setPolicy(companyId, null);
    const inst = await submit(a, companyId, templateKey);
    const done = await workflow.decide(a, inst.steps[0].id, { decision: "approved" });
    expect(done.status).toBe("approved");
  });

  it("with blockSelfApproval the submitter cannot approve, another approver can, and nothing was recorded for the blocked attempt", async () => {
    await setPolicy(companyId, true);
    const inst = await submit(a, companyId, templateKey);
    await expect(workflow.decide(a, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(ForbiddenException);
    await expect(workflow.decide(a, inst.steps[0].id, { decision: "approved" })).rejects.toThrow(/cannot approve your own request/);
    const still = await workflow.getInstance(a, inst.id);
    expect(still.status).toBe("in_progress");
    const done = await workflow.decide(b, inst.steps[0].id, { decision: "approved" });
    expect(done.status).toBe("approved");
  });

  it("the submitter may still reject or send back their own request under the policy", async () => {
    await setPolicy(companyId, true);
    const inst = await submit(a, companyId, templateKey);
    const rejected = await workflow.decide(a, inst.steps[0].id, { decision: "rejected", comment: "Withdrawn" });
    expect(rejected.status).toBe("rejected");
  });

  it("switching the policy off restores self-approval, and another company's policy never applies", async () => {
    await setPolicy(companyId, false);
    const own = await submit(a, companyId, templateKey);
    expect((await workflow.decide(a, own.steps[0].id, { decision: "approved" })).status).toBe("approved");

    await setPolicy(companyId, true);
    await setPolicy(otherCompanyId, null);
    const other = await submit(outsiderCompanyUser, otherCompanyId, templateKey);
    expect((await workflow.decide(outsiderCompanyUser, other.steps[0].id, { decision: "approved" })).status).toBe("approved");
  });
});
