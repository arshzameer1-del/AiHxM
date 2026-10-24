import { Pool, type PoolClient } from "pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { EmployeeDocumentComplianceService } from "./employee-document-compliance.service";
import { EmployeesService } from "./employees.service";
import { CONSISTENCY_CHECKS } from "./employee-data-consistency.checks";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-document-compliance-spec" };
const pdf = (name = "cnic.pdf") => ({ originalname: name, mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4 test"), size: 13 });
const png = { originalname: "me.png", mimetype: "image/png", buffer: Buffer.from("fakepng"), size: 7 };

/** BACKLOG50 against real Postgres: expiry dates, employee uploads that wait for HR, the mandatory checklist and the photo. */
describe("Employee documents - review, checklist, photo", () => {
  let pool: Pool;
  let db: DatabaseService;
  let employees: EmployeesService;
  let svc: EmployeeDocumentComplianceService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let other: RequestClaims;
  let me: string;
  let colleague: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const row = async (sql: string, args: unknown[]) => (await fx((c) => c.query(sql, args))).rows;
  let n = 0;

  async function makeEmployee(c: PoolClient, userId: string | null) {
    n += 1;
    const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, $2) RETURNING id", [a, `P ${n}`]);
    return (
      await c.query(
        "INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'D',$3,$4,$5) RETURNING id",
        [a, `DC-${n}-${stamp}`.slice(0, 30), `E${n}`, p.rows[0].id, userId]
      )
    ).rows[0].id as string;
  }
  const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const cat = { validateActiveCode: async () => undefined } as never;
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService(), undefined, undefined, undefined, undefined, undefined, cat);
    svc = new EmployeeDocumentComplianceService(db, rbac, ent, audit, employees, cat, new HrBusinessPolicyService(db, rbac, ent, audit));
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`DC ${stamp}`, `dc-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`dc-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      other = await mkUser("other", "employee_self_service");
      me = await makeEmployee(c, ess.sub as string);
      colleague = await makeEmployee(c, other.sub as string);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("HR uploads with an expiry date and a note; it is approved at once", async () => {
    const doc = await employees.addDocument(hr, me, "passport", pdf("passport.pdf"), { expiryDate: ymd(400), note: "Renewed 2026" });
    expect(doc.reviewStatus).toBe("approved");
    expect(doc.expiryDate).toBe(ymd(400));
    expect(doc.note).toBe("Renewed 2026");
    await expect(employees.addDocument(hr, me, "passport", pdf(), { expiryDate: "not-a-date" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an employee's own upload waits for HR; only they and HR can see or download it", async () => {
    const doc = await employees.addOwnDocument(ess, me, "cnic", pdf(), { expiryDate: ymd(900) });
    expect(doc.reviewStatus).toBe("pending");

    expect((await employees.listDocuments(ess, me)).map((d) => d.id)).toContain(doc.id);
    expect((await employees.listDocuments(hr, me)).map((d) => d.id)).toContain(doc.id);
    expect((await employees.downloadDocument(ess, me, doc.id)).fileName).toBe("cnic.pdf");
    expect((await employees.downloadDocument(hr, me, doc.id)).fileName).toBe("cnic.pdf");

    // a colleague cannot see it, cannot upload to this file
    await expect(employees.listDocuments(other, me)).rejects.toBeInstanceOf(NotFoundException);
    await expect(employees.addOwnDocument(other, me, "cnic", pdf())).rejects.toBeInstanceOf(ForbiddenException);
    // and HR cannot use the self door on someone else's behalf
    await expect(employees.addOwnDocument(ess, colleague, "cnic", pdf())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("HR sees the pending inbox, approves with a note; rejecting needs a reason; a decision is final", async () => {
    const pending = await svc.listPending(hr);
    const mine = pending.find((p) => p.employeeId === me && p.documentType === "cnic")!;
    expect(mine.employeeName).toContain("E");
    await expect(svc.listPending(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.review(ess, mine.id, "approved")).rejects.toBeInstanceOf(ForbiddenException);

    await expect(svc.review(hr, mine.id, "rejected")).rejects.toBeInstanceOf(BadRequestException);
    const ok = await svc.review(hr, mine.id, "approved", "Clear scan");
    expect(ok.reviewStatus).toBe("approved");
    expect(ok.reviewNote).toBe("Clear scan");
    expect(ok.reviewedAt).toBeTruthy();
    await expect(svc.review(hr, mine.id, "approved")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.review(hr, "00000000-0000-4000-8000-000000000000", "approved")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a rejected upload stays visible to its owner with the reason, but never counts", async () => {
    const doc = await employees.addOwnDocument(ess, me, "degree_certificate", pdf("degree.pdf"));
    const rejected = await svc.review(hr, doc.id, "rejected", "Photo is blurred");
    expect(rejected.reviewStatus).toBe("rejected");
    const seen = (await employees.listDocuments(ess, me)).find((d) => d.id === doc.id)!;
    expect(seen.reviewNote).toBe("Photo is blurred");
  });

  it("at most 10 uploads can wait for HR at once", async () => {
    await fx((c) => c.query("DELETE FROM employee_documents WHERE employee_id = $1 AND review_status = 'pending'", [colleague]));
    for (let i = 0; i < 10; i++) await employees.addOwnDocument(other, colleague, "other", pdf(`f${i}.pdf`));
    await expect(employees.addOwnDocument(other, colleague, "other", pdf("one-too-many.pdf"))).rejects.toBeInstanceOf(BadRequestException);
    await fx((c) => c.query("DELETE FROM employee_documents WHERE employee_id = $1", [colleague]));
  });

  it("mandatory document types give an on-file / waiting / missing / expired checklist", async () => {
    await expect(svc.setRequired(ess, ["cnic"])).rejects.toBeInstanceOf(ForbiddenException);
    const saved = await svc.setRequired(hr, ["cnic", "passport", "offer_letter", "photograph"]);
    expect(saved.documentTypes).toEqual(["cnic", "offer_letter", "passport", "photograph"]);
    expect((await svc.getRequired(ess)).documentTypes).toHaveLength(4); // employees can see what is expected of them
    // one source of truth: the HR Administration Document Policy itself now holds the list
    const policy = await row("SELECT rules FROM hr_business_policies WHERE company_id = $1 AND policy_type = 'document' AND is_default", [a]);
    expect(policy[0].rules.requiredDocumentTypes).toEqual(["cnic", "offer_letter", "passport", "photograph"]);

    // a fresh employee: nothing on file
    const fresh = await fx((c) => makeEmployee(c, null));
    const empty = await svc.checklist(hr, fresh);
    expect(empty.items.map((i) => i.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(empty.completeCount).toBe(0);
    expect(empty.requiredCount).toBe(4);

    // `me`: cnic approved (in date), passport approved (in date), offer_letter pending, photograph missing
    await employees.addOwnDocument(ess, me, "offer_letter", pdf("offer.pdf"));
    const list = await svc.checklist(ess, me);
    const by = Object.fromEntries(list.items.map((i) => [i.documentType, i.status]));
    expect(by).toEqual({ cnic: "on_file", offer_letter: "pending", passport: "on_file", photograph: "missing" });
    expect(list.completeCount).toBe(2);

    // an expired passport with no newer copy
    await fx((c) => c.query("UPDATE employee_documents SET expiry_date = $2 WHERE employee_id = $1 AND document_type = 'passport'", [me, ymd(-3)]));
    expect((await svc.checklist(hr, me)).items.find((i) => i.documentType === "passport")!.status).toBe("expired");
    // a renewed one in date replaces it
    await employees.addDocument(hr, me, "passport", pdf("passport2.pdf"), { expiryDate: ymd(3000) });
    expect((await svc.checklist(hr, me)).items.find((i) => i.documentType === "passport")!.status).toBe("on_file");

    // a colleague cannot read someone else's checklist
    await expect(svc.checklist(other, me)).rejects.toBeInstanceOf(NotFoundException);
    // replacing the list drops what is no longer mandatory
    expect((await svc.setRequired(hr, ["cnic"])).documentTypes).toEqual(["cnic"]);
    expect((await svc.checklist(hr, me)).requiredCount).toBe(1);
  });

  it("the data-consistency screen flags missing and expired mandatory documents", async () => {
    await svc.setRequired(hr, ["cnic", "offer_letter"]);
    const run = async (id: string) => {
      const check = CONSISTENCY_CHECKS.find((c) => c.id === id)!;
      return row(`SELECT e.id, ${check.detail} AS detail FROM employees e ${check.joins ?? ""} WHERE e.company_id = $1 AND (${check.where})`, [a]);
    };
    const missing = await run("mandatory_document_missing");
    expect(missing.some((r) => r.id === me && String(r.detail).includes("offer_letter"))).toBe(true); // still pending, not approved
    expect(missing.some((r) => r.id === me && String(r.detail).includes("cnic"))).toBe(false);

    await fx((c) => c.query("UPDATE employee_documents SET expiry_date = $2 WHERE employee_id = $1 AND document_type = 'cnic'", [me, ymd(-1)]));
    const expired = await run("document_expired");
    expect(expired.some((r) => r.id === me && String(r.detail).includes("cnic"))).toBe(true);
  });

  it("the profile photo is the latest APPROVED image of type photograph (company rule: employee photos wait for HR)", async () => {
    // BACKLOG55: by default an employee's photo shows at once; this company asks for HR approval first.
    await fx((c) => c.query("INSERT INTO company_appearance (company_id, photo_needs_hr_approval) VALUES ($1, true) ON CONFLICT (company_id) DO UPDATE SET photo_needs_hr_approval = true", [a]));
    expect(await svc.photo(ess, me)).toBeNull();
    await expect(employees.addOwnDocument(ess, me, "photograph", pdf("not-an-image.pdf"))).rejects.toBeInstanceOf(BadRequestException);
    const mine = await employees.addOwnDocument(ess, me, "photograph", png);
    expect(await svc.photo(ess, me)).toBeNull(); // pending photos are not shown yet
    await svc.review(hr, mine.id, "approved");
    const photo = await svc.photo(hr, me);
    expect(photo!.mimeType).toBe("image/png");
    expect(photo!.buffer.toString()).toBe("fakepng");
    // BACKLOG59: a photo is directory information - a colleague (no HR / manager rights) sees it too ...
    const seenByColleague = await svc.photo(other, me);
    expect(seenByColleague!.buffer.toString()).toBe("fakepng");
    // ... but never across companies
    const stranger = { is_platform_admin: false, company_id: "00000000-0000-4000-8000-000000000001", sub: other.sub } as RequestClaims;
    await expect(svc.photo(stranger, me)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("approving writes an audit entry", async () => {
    const rows = await row("SELECT action FROM audit_log WHERE company_id = $1 AND action LIKE 'employee_document.%'", [a]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
