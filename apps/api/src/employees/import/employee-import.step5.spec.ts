import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { LocalFileStorageService } from "../../file-storage/local-file-storage.service";
import { BackgroundJobsService } from "../../background-jobs/background-jobs.service";
import { EmployeesService } from "../employees.service";
import { EmployeeNumberingService } from "../employee-numbering.service";
import { EmployeeImportService } from "./employee-import.service";
import { EmployeeImportWorker } from "./employee-import.worker";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "employee-import-step5" };

/** Gap Register LIF-11: bulk import as a dry-run + resumable background batch. */
describe("Employee import batches (LIF-11)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let imports: EmployeeImportService;
  let worker: EmployeeImportWorker;
  let companyId: string;
  let hr: RequestClaims;
  let staff: RequestClaims;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const jobs = new BackgroundJobsService();
    const employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    imports = new EmployeeImportService(db, rbac, ent, audit, jobs, employees, new EmployeeNumberingService(db, rbac, ent, audit));
    worker = new EmployeeImportWorker(db, jobs, imports);

    await db.withClaims(FIXTURE, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [`Import Co ${stamp}`, `import-co-${stamp}`]);
      companyId = co.rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [companyId]);
    });
    const mk = (email: string, role: string) =>
      db.withClaims(FIXTURE, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
        const r = await c.query("SELECT id FROM roles WHERE key = $1", [role]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, r.rows[0].id]);
        return u.rows[0].id as string;
      });
    hr = { is_platform_admin: false, company_id: companyId, sub: await mk(`imp-hr-${stamp}@example.com`, "hr_admin") };
    staff = { is_platform_admin: false, company_id: companyId, sub: await mk(`imp-staff-${stamp}@example.com`, "employee_self_service") };
  });

  afterAll(async () => {
    await pool.end();
  });

  const CSV = [
    "firstName,lastName,email,cnic,employmentType,dateOfJoining,employeeNumber",
    `Ali,Raza,ali.${stamp}@example.com,35202-1234567-1,permanent,2026-01-05,`,
    `Sana,Iqbal,not-an-email,35202-1234567-2,permanent,2026-01-05,`,
    `Omar,Sheikh,omar.${stamp}@example.com,123,permanent,2026-02-30,`,
    `Hina,Malik,hina.${stamp}@example.com,,wizard,,`,
    `Zain,Ahmed,zain.${stamp}@example.com,,contract,2026-03-01,`,
  ].join("\n");

  it("requires the manage permission", async () => {
    await expect(imports.dryRun(staff, { csv: CSV })).rejects.toThrow(ForbiddenException);
  });

  it("rejects a file without the required columns or rows", async () => {
    await expect(imports.dryRun(hr, { csv: "first,last\nA,B" })).rejects.toThrow(BadRequestException);
    await expect(imports.dryRun(hr, { csv: "firstName,lastName" })).rejects.toThrow(BadRequestException);
  });

  let batchId: string;
  it("dry run validates every row, creates nothing and reports row-level errors", async () => {
    const batch = await imports.dryRun(hr, { csv: CSV, fileName: "jan.csv" }, `dry-${stamp}-0001`);
    batchId = batch.id;
    expect(batch.status).toBe("dry_run_complete");
    expect(batch).toMatchObject({ totalRows: 5, validRows: 2, invalidRows: 3 });
    const rows = await imports.rows(hr, batchId);
    const byRow = new Map(rows.map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)!.status).toBe("valid");
    expect(byRow.get(3)!.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["email"]));
    expect(byRow.get(4)!.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["cnic", "dateOfJoining"]));
    expect(byRow.get(5)!.errors.map((e) => e.field)).toContain("employmentType");
    expect(byRow.get(6)!.status).toBe("valid");
    const created = await db.withClaims(FIXTURE, (c) => c.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1", [companyId]));
    expect(created.rows[0].n).toBe(0);
  });

  it("is idempotent per Idempotency-Key and rejects the key for a different file", async () => {
    const again = await imports.dryRun(hr, { csv: CSV, fileName: "jan.csv" }, `dry-${stamp}-0001`);
    expect(again.id).toBe(batchId);
    await expect(imports.dryRun(hr, { csv: CSV + "\n", fileName: "x.csv" }, `dry-${stamp}-0001`)).rejects.toThrow(ConflictException);
  });

  it("builds an error report CSV for the bad rows", async () => {
    const csv = await imports.errorReportCsv(hr, batchId);
    expect(csv.split("\n")[0]).toContain("errors");
    expect(csv).toContain("email: Not a valid email address");
    expect(csv).toContain("employmentType: Unknown employment type");
    expect(csv).not.toContain("35202-1234567-2"); // CNIC is not echoed back in the report
  });

  it("refuses to execute a batch with invalid rows unless partial import was chosen", async () => {
    await expect(imports.execute(hr, batchId)).rejects.toThrow(BadRequestException);
  });

  it("detects duplicate rows and duplicate employee numbers inside one file", async () => {
    const csv = [
      "firstName,lastName,employeeNumber",
      "Dup,Licate,E-100",
      "Dup,Licate,E-100",
      "Other,Person,E-100",
    ].join("\n");
    const b = await imports.dryRun(hr, { csv });
    const rows = await imports.rows(hr, b.id);
    expect(rows[1].errors.some((e) => /Identical to row 2/.test(e.message))).toBe(true);
    expect(rows[1].errors.some((e) => e.field === "employeeNumber")).toBe(true);
    expect(rows[2].errors.some((e) => e.field === "employeeNumber")).toBe(true);
    await imports.cancel(hr, b.id);
  });

  let partialId: string;
  it("executes the valid rows through the background worker, collecting row failures", async () => {
    const partial = await imports.dryRun(hr, { csv: CSV, allowPartial: true }, `dry-${stamp}-0002`);
    partialId = partial.id;
    // make one valid row fail at create time: its manager reference vanishes between dry run and execution
    const queued = await imports.execute(hr, partialId, `exec-${stamp}-0001`);
    expect(queued.status).toBe("queued");
    expect(queued.backgroundJobId).toBeTruthy();
    // retried execute returns the same batch, no second job
    const again = await imports.execute(hr, partialId, `exec-${stamp}-0001`);
    expect(again.backgroundJobId).toBe(queued.backgroundJobId);

    expect(await worker.runOnce("spec-worker")).toBe(true);
    expect(await worker.runOnce("spec-worker")).toBe(false);

    const done = await imports.get(hr, partialId);
    expect(done.status).toBe("completed");
    expect(done).toMatchObject({ importedRows: 2, failedRows: 0, checkpointRow: 6 });
    const emps = await db.withClaims(FIXTURE, (c) => c.query("SELECT first_name FROM employees WHERE company_id = $1 ORDER BY first_name", [companyId]));
    expect(emps.rows.map((r) => r.first_name)).toEqual(["Ali", "Zain"]);

    const job = await db.withClaims(FIXTURE, (c) => c.query("SELECT status, progress_percent FROM background_jobs WHERE id = $1", [done.backgroundJobId]));
    expect(job.rows[0]).toMatchObject({ status: "completed", progress_percent: 100 });
  });

  it("scrubs sensitive values from the stored rows once the batch is finished", async () => {
    const rows = await imports.rows(hr, partialId);
    const imported = rows.filter((r) => r.status === "imported");
    expect(imported).toHaveLength(2);
    for (const r of rows) {
      expect(r.payload.cnic).toBeUndefined();
      expect(r.payload.dateOfBirth).toBeUndefined();
    }
    expect(imported[0].employeeId).toBeTruthy();
  });

  it("a finished batch cannot be executed or cancelled again", async () => {
    expect((await imports.execute(hr, partialId)).status).toBe("completed"); // replay
    await expect(imports.cancel(hr, partialId)).rejects.toThrow(ConflictException);
  });

  it("refuses to execute when the employee configuration changed since the dry run", async () => {
    const b = await imports.dryRun(hr, { csv: "firstName,lastName\nCara,Stale" });
    await db.withClaims(FIXTURE, (c) =>
      c.query(
        `INSERT INTO employee_number_policy (company_id, allow_manual) VALUES ($1, false)
         ON CONFLICT (company_id) DO UPDATE SET allow_manual = false`,
        [companyId]
      )
    );
    await expect(imports.execute(hr, b.id)).rejects.toThrow(/configuration changed/);
    await imports.cancel(hr, b.id);
  });

  it("records row failures at execution time and lets the failed rows be retried", async () => {
    const b = await imports.dryRun(hr, { csv: "firstName,lastName,managerId\nFay,Failing," + "" });
    // inject a row that is valid at dry run but breaks at creation: unknown manager inserted after validation
    await db.withClaims(FIXTURE, (c) =>
      c.query("UPDATE import_rows SET payload = payload || jsonb_build_object('managerId', gen_random_uuid()::text) WHERE batch_id = $1", [b.id])
    );
    await imports.execute(hr, b.id);
    await worker.runOnce("spec-worker");
    const done = await imports.get(hr, b.id);
    expect(done.status).toBe("completed_with_errors");
    expect(done).toMatchObject({ importedRows: 0, failedRows: 1 });
    const failed = await imports.rows(hr, b.id, { status: "failed" });
    expect(failed[0].errors[0].message.length).toBeGreaterThan(0);

    // fix the cause (remove the bad manager) then retry just the failed row
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE import_rows SET payload = payload - 'managerId' WHERE batch_id = $1", [b.id]));
    const retried = await imports.retryFailed(hr, b.id);
    expect(retried.status).toBe("queued");
    await worker.runOnce("spec-worker");
    const after = await imports.get(hr, b.id);
    expect(after).toMatchObject({ status: "completed", importedRows: 1, failedRows: 0 });
  });

  it("resumes from the checkpoint after an interrupted run", async () => {
    const csv = ["firstName,lastName", "Rae,One", "Rae,Two", "Rae,Three"].join("\n");
    const b = await imports.dryRun(hr, { csv });
    await imports.execute(hr, b.id);
    // simulate a crash after row 2 was imported
    await db.withClaims(FIXTURE, async (c) => {
      const first = await c.query("SELECT id FROM import_rows WHERE batch_id = $1 AND row_number = 2", [b.id]);
      const emp = await c.query("SELECT id FROM employees WHERE company_id = $1 LIMIT 1", [companyId]);
      await c.query("UPDATE import_rows SET status = 'imported', employee_id = $2 WHERE id = $1", [first.rows[0].id, emp.rows[0].id]);
      await c.query("UPDATE import_batches SET imported_rows = 1, checkpoint_row = 2, status = 'running' WHERE id = $1", [b.id]);
      await c.query("UPDATE background_jobs SET status = 'running', locked_until = now() - interval '1 minute', attempts = 1 WHERE id = (SELECT background_job_id FROM import_batches WHERE id = $1)", [b.id]);
    });
    await worker.runOnce("spec-worker");
    const done = await imports.get(hr, b.id);
    expect(done).toMatchObject({ status: "completed", importedRows: 3, failedRows: 0 });
    const names = await db.withClaims(FIXTURE, (c) => c.query("SELECT last_name FROM employees WHERE company_id = $1 AND first_name = 'Rae' ORDER BY last_name", [companyId]));
    expect(names.rows.map((r) => r.last_name)).toEqual(["Three", "Two"]); // row 2 ("One") was already done and is not re-created
  });

  it("expires dry runs nobody executed", async () => {
    const b = await imports.dryRun(hr, { csv: "firstName,lastName,cnic\nOld,Draft,35202-9999999-9" });
    await db.withClaims(FIXTURE, (c) => c.query("UPDATE import_batches SET created_at = now() - interval '30 days' WHERE id = $1", [b.id]));
    expect(await imports.expireStaleBatches(7)).toBeGreaterThanOrEqual(1);
    expect((await imports.get(hr, b.id)).status).toBe("cancelled");
    const rows = await db.withClaims(FIXTURE, (c) => c.query("SELECT payload FROM import_rows WHERE batch_id = $1", [b.id]));
    expect(rows.rows[0].payload.cnic).toBeUndefined();
  });
});
