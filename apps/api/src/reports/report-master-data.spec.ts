import { ForbiddenException } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import type { ReportResult } from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ReportsService } from "./reports.service";
import { toCsvWithSections } from "./engine/csv";
import { buildFile } from "./export/formats";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "report-master-data-spec-fixtures" };

/** Employee master data (B16 to B20) against real Postgres, with hand-counted figures. */
describe("Employee master data reports B16 to B20", () => {
  let pool: Pool;
  let db: DatabaseService;
  let reports: ReportsService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let b: string;
  let hr: RequestClaims;
  let hrB: RequestClaims;
  let mgr: RequestClaims;
  let ess: RequestClaims;
  let today: string;
  const e: Record<string, string> = {};
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);
  const day = (offset: number): string => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  async function makeUser(client: PoolClient, companyId: string, tag: string, roleKey: string): Promise<RequestClaims> {
    const u = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`md-${tag}-${stamp}@example.com`]);
    const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
    await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, role.rows[0].id]);
    return { is_platform_admin: false, company_id: companyId, sub: u.rows[0].id };
  }
  async function makeEmployee(client: PoolClient, companyId: string, n: string, o: { first: string; status?: string; joined: string; left?: string | null; unit?: string | null; type?: string; band?: string | null; user?: string }) {
    const p = await client.query("INSERT INTO persons (company_id, full_name, gender, nationality) VALUES ($1, $2, 'female', 'Pakistani') RETURNING id", [companyId, `${o.first} ${n}`]);
    const r = await client.query(
      `INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, employment_status, date_of_joining, termination_date, org_unit_id, employment_type, salary_band, user_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [companyId, `MD-${n}-${stamp}`.slice(0, 30), o.first, `Emp${n}`, p.rows[0].id, o.status ?? "active", o.joined, o.left ?? null, o.unit ?? null, o.type ?? "permanent", o.band ?? null, o.user ?? null]
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    reports = new ReportsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
    today = (await fx((cl) => cl.query("SELECT ((now() AT TIME ZONE 'Asia/Karachi')::date)::text AS d"))).rows[0].d;
    await fx(async (c) => {
      const mk = async (label: string) => {
        const modules = ["employee", "leave", "payroll"];
        const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`MD ${label} ${stamp}`, `md-${label}-${stamp}`.toLowerCase()]);
        await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [r.rows[0].id, JSON.stringify(modules)]);
        for (const m of modules) await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [r.rows[0].id, m]);
        return r.rows[0].id as string;
      };
      a = await mk("a");
      b = await mk("b");
      hr = await makeUser(c, a, "hr", "hr_admin");
      hrB = await makeUser(c, b, "hrb", "hr_admin");
      mgr = await makeUser(c, a, "mgr", "line_manager");
      ess = await makeUser(c, a, "ess", "employee_self_service");
      const unit = (await c.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', 'Engineering') RETURNING id", [a])).rows[0].id;

      e.ayesha = await makeEmployee(c, a, "1", { first: "Ayesha", joined: day(-730), unit, band: "G5" });
      e.bilal = await makeEmployee(c, a, "2", { first: "Bilal", joined: day(-100), unit, type: "contract", band: "G3" });
      e.left = await makeEmployee(c, a, "3", { first: "Zara", status: "terminated", joined: day(-900), left: day(-20), unit });
      await makeEmployee(c, b, "b1", { first: "Other", joined: day(-50) });

      // Ayesha's file: phone, email, current address, emergency contact, 2 family (1 dependant + beneficiary), education, 2 qualifications, 2 documents, 1 asset
      const contact = (t: string, label: string | null, value: string, primary = false) =>
        c.query("INSERT INTO employee_contacts (company_id, employee_id, contact_type, label, value, is_primary) VALUES ($1,$2,$3,$4,$5,$6)", [a, e.ayesha, t, label, value, primary]);
      await contact("business_email", null, "ayesha@work.example", true);
      await contact("personal_phone", null, "0300-1111111", true);
      await contact("emergency_contact", "Bilal Khan", "0301-2222222");
      await c.query("INSERT INTO employee_addresses (company_id, employee_id, address_type, line1, city, country) VALUES ($1,$2,'current','12 Canal Road','Lahore','Pakistan')", [a, e.ayesha]);
      await c.query("INSERT INTO employee_family_members (company_id, employee_id, relationship, full_name, is_dependent, is_beneficiary) VALUES ($1,$2,'spouse','Hamza Khan',true,true),($1,$2,'child','Noor Khan',false,false)", [a, e.ayesha]);
      await c.query("INSERT INTO employee_education (company_id, employee_id, degree_title, institution, end_date) VALUES ($1,$2,'BS Computer Science','LUMS',$3)", [a, e.ayesha, day(-3000)]);
      await c.query("INSERT INTO employee_qualifications (company_id, employee_id, qualification_type, title, expiry_date) VALUES ($1,$2,'certification','PMP',$3),($1,$2,'certification','AWS',$4)", [a, e.ayesha, day(30), day(-10)]);
      for (const f of ["cnic.pdf", "degree.pdf"]) await c.query("INSERT INTO employee_documents (company_id, employee_id, document_type, file_name, mime_type, size_bytes, storage_path) VALUES ($1,$2,'identity',$3,'application/pdf',2048,$4)", [a, e.ayesha, f, `x/${stamp}/${f}`]);
      await c.query("INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag, assigned_date, status) VALUES ($1,$2,'laptop','LT-1',$3,'assigned')", [a, e.ayesha, day(-60)]);
      // pay: Ayesha 100000 verified account at Meezan; Bilal 50000 and no payment account
      await c.query("INSERT INTO employee_compensation (company_id, employee_id, monthly_salary, effective_from, created_by_user_account_id) VALUES ($1,$2,100000,$3,$5),($1,$4,50000,$3,$5)", [a, e.ayesha, day(-365), e.bilal, hr.sub]);
      await c.query(
        `INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, bank_name, account_title, account_number, is_primary, status, verification_status, approval_status, valid_from)
         VALUES ($1,$2,'bank_transfer','Meezan','Ayesha Emp1','enc:v1:1:fake',true,'active','verified','approved',$3)`,
        [a, e.ayesha, day(-365)]
      );
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const kpi = (r: ReportResult, key: string) => r.kpis.find((k) => k.key === key)?.value;
  const row = (r: ReportResult, name: string) => r.rows.find((x) => String(x.name).includes(name));
  const section = (r: ReportResult, key: string) => {
    const s = r.sections?.find((x) => x.key === key);
    if (!s) throw new Error(`no section ${key}`);
    return s;
  };

  it("B17 lists everyone including the leaver, with service years, and the leaver appears under Leavers", async () => {
    const r = await reports.run(hr, "B17", {});
    expect(r.rows).toHaveLength(3);
    expect(kpi(r, "current")).toBe(2);
    expect(kpi(r, "left")).toBe(1);
    expect(row(r, "Ayesha")).toMatchObject({ gender: "Female", nationality: "Pakistani", type: "Permanent", unit: "Engineering", dob: "No" });
    expect(Number(row(r, "Ayesha")?.tenure)).toBeCloseTo(2, 0);
    expect(section(r, "leavers").rows).toHaveLength(1);
    expect(section(r, "by-unit").rows).toEqual([expect.objectContaining({ label: "Engineering", employees: 2 })]);
    expect(section(r, "by-type").rows.map((x) => x.label).sort()).toEqual(["Contract", "Permanent"]);
    expect(section(r, "tenure-bands").rows.reduce((s, x) => s + Number(x.employees), 0)).toBe(2);
  });

  it("B18 shows contacts, address and emergency contact, and says exactly what is missing", async () => {
    const r = await reports.run(hr, "B18", {});
    expect(r.rows).toHaveLength(2); // current employees only
    expect(row(r, "Ayesha")).toMatchObject({ businessEmail: "ayesha@work.example", personalPhone: "0300-1111111", emergency: "Bilal Khan (0301-2222222)", missing: null });
    expect(String(row(r, "Ayesha")?.currentAddress)).toContain("Lahore");
    expect(row(r, "Bilal")?.missing).toBe("Phone, Email, Address, Emergency contact");
    expect(kpi(r, "noEmergency")).toBe(1);
    expect(section(r, "contact-records").rows).toHaveLength(3);
    expect(section(r, "address-records").rows).toHaveLength(1);
    expect(section(r, "missing").rows).toHaveLength(1);
    expect(section(r, "by-city").rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Lahore", employees: 1 }), expect.objectContaining({ label: "Not set", employees: 1 })]));
  });

  it("B20 counts family, education, qualifications, documents and assets, and flags expiry", async () => {
    const r = await reports.run(hr, "B20", {});
    expect(row(r, "Ayesha")).toMatchObject({ family: 2, dependants: 1, beneficiaries: 1, education: 1, qualifications: 2, documents: 2, assets: 1, latestDegree: "BS Computer Science, LUMS" });
    expect(row(r, "Ayesha")?.nextExpiry).toBe(day(30));
    expect(row(r, "Bilal")).toMatchObject({ family: 0, documents: 0, assets: 0 });
    expect(section(r, "family").rows).toHaveLength(2);
    const states = section(r, "qualifications").rows.map((x) => x.state).sort();
    expect(states).toEqual(["Expired", "Expires within 90 days"]);
    expect(section(r, "documents-by-type").rows[0]).toMatchObject({ label: "Identity", documents: 2, employees: 1 });
    expect(section(r, "assets-by-type").rows[0]).toMatchObject({ label: "Laptop", issued: 1 });
  });

  it("B19 shows pay and bank status, never account numbers, and flags the person with no account", async () => {
    const r = await reports.run(hr, "B19", {});
    expect(row(r, "Ayesha")).toMatchObject({ bank: "Meezan", account: "Yes", iban: "No", verification: "Verified", salary: 100000, band: "G5" });
    expect(row(r, "Bilal")).toMatchObject({ bank: null, account: "No", salary: 50000 });
    expect(kpi(r, "monthlyTotal")).toBe(150000);
    expect(kpi(r, "noBank")).toBe(1);
    expect(JSON.stringify(r)).not.toContain("enc:v1");
    const byUnit = section(r, "pay-by-unit").rows[0];
    expect(byUnit).toMatchObject({ label: "Engineering", employees: 2, paid: 2, total: 150000, average: 75000, lowest: 50000, highest: 100000 });
    expect(section(r, "salary-history").rows).toHaveLength(2);
    expect(section(r, "bank-exceptions").rows).toEqual([expect.objectContaining({ issue: "No payment account" })]);
    expect(section(r, "by-bank").rows).toEqual([expect.objectContaining({ label: "Meezan", employees: 1, verified: 1 })]);
  });

  it("B16 puts the whole file in one row, with no pay amounts and no encrypted values", async () => {
    const r = await reports.run(hr, "B16", {});
    expect(r.rows).toHaveLength(3);
    expect(row(r, "Ayesha")).toMatchObject({ businessEmail: "ayesha@work.example", city: "Lahore", family: 2, education: 1, qualifications: 2, documents: 2, assets: 1, bank: "Yes", missing: null });
    expect(r.columns.map((c) => c.key)).not.toContain("salary");
    const completeness = section(r, "completeness").rows;
    expect(completeness.find((x) => x.label === "Phone number")).toMatchObject({ recorded: 1, missing: 1, complete: 50 });
    expect(completeness.find((x) => x.label === "Bank account")).toMatchObject({ recorded: 1, missing: 1 });
  });

  it("other companies never appear, and a manager or an employee cannot open master data", async () => {
    const other = await reports.run(hrB, "B16", {});
    expect(other.rows).toHaveLength(1);
    expect(String(other.rows[0]?.number)).toContain("MD-b1");
    for (const id of ["B16", "B17", "B18", "B19", "B20"]) {
      await expect(reports.run(ess, id, {})).rejects.toThrow(ForbiddenException);
    }
    await expect(reports.run(mgr, "B19", {})).rejects.toThrow(ForbiddenException);
    await expect(reports.run(mgr, "B16", {})).rejects.toThrow(ForbiddenException);
  });

  it("exports carry every section: CSV blocks, one Excel sheet each, PDF headings", async () => {
    const r = await reports.run(hr, "B20", {});
    const csv = toCsvWithSections(r.columns, r.rows, ["meta"], r.sections ?? []);
    expect(csv).toContain("# Section: Family members");
    expect(csv).toContain("Hamza Khan");
    const xlsx = await buildFile(r, "xlsx", 10000);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["Report", "Family members", "Qualifications and certificatio", "Documents on file"]));
    expect(names.every((n) => n.length <= 31)).toBe(true);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    const pdf = await buildFile(r, "pdf", 10000);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
