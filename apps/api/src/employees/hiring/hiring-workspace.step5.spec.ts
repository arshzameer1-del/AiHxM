import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { LocalFileStorageService } from "../../file-storage/local-file-storage.service";
import { EffectiveDatingEngine } from "../../effective-dating/effective-dating.engine";
import { RulesEngine } from "../../rules-engine/rules-engine.engine";
import { ShiftsService } from "../../shifts/shifts.service";
import { EmployeeCompensationService } from "../employee-compensation.service";
import { EmployeesService } from "../employees.service";
import { EmployeeNumberingService } from "../employee-numbering.service";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { HrBusinessPolicyService } from "../../hr-administration/hr-business-policy.service";
import { HiringProcessService } from "./hiring-process.service";
import { CardFieldConfigService } from "./card-field-config.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hiring-step5-fixtures" };

/**
 * Gap Register CFG-08..CFG-13 (Step 5A-5C): hire state machine, validation,
 * approval, ownership and retention, card/field metadata, numbering ledger.
 */
describe("Hiring workspace completion (CFG-08..13)", () => {
  let pool: Pool;
  let db: DatabaseService;
  let hiring: HiringProcessService;
  let employees: EmployeesService;
  let numbering: EmployeeNumberingService;
  let cardFields: CardFieldConfigService;
  let companyId: string;
  let hr: RequestClaims;
  let hr2: RequestClaims;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.withClaims(FIXTURE, async (c) => (await c.query(text, params)).rows as T[]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    employees = new EmployeesService(db, rbac, ent, audit, new LocalFileStorageService());
    numbering = new EmployeeNumberingService(db, rbac, ent, audit);
    cardFields = new CardFieldConfigService(db, rbac, ent, audit, new CustomFieldsService(db, rbac));
    const shifts = new ShiftsService(db, rbac, ent, audit, new EffectiveDatingEngine(), new RulesEngine());
    const compensation = new EmployeeCompensationService(db, rbac, ent, audit, new EffectiveDatingEngine());
    hiring = new HiringProcessService(db, rbac, ent, audit, employees, undefined, undefined, undefined, shifts, undefined, undefined, compensation);
    // optional approval policy lookup
    (hiring as unknown as { businessPolicy: HrBusinessPolicyService }).businessPolicy = new HrBusinessPolicyService(db, rbac, ent, audit);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`H5 ${stamp}`, `h5-${stamp}`])).rows[0].id;
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true), ($1,'leave',true)", [companyId]);
      const mk = async (label: string): Promise<RequestClaims> => {
        const id = (await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`h5-${label}-${stamp}@example.com`])).rows[0].id;
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key='hr_admin'))", [id, companyId]);
        return { sub: id, company_id: companyId, is_platform_admin: false };
      };
      hr = await mk("a");
      hr2 = await mk("b");
    });
  });

  afterEach(async () => {
    await numbering.updatePolicy(hr, { generationTiming: "hire", resetPolicy: "never", allowManual: true, manualPattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$" });
    await sql("UPDATE hr_business_policies SET is_active = false WHERE company_id = $1 AND policy_type = 'hiring'", [companyId]);
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  });

  const REQUIRED_PAYLOADS: Record<string, Record<string, unknown>> = {
    personal_identity: { firstName: "Hira", lastName: "Tester" },
    employment: { employmentType: "permanent", dateOfJoining: "2026-01-01" },
    organization_assignment: { note: "HQ" },
    review_completion: { reviewed: true },
  };

  /** Saves every required card and walks Next until the process is ready for completion. */
  async function driveToReady(claims = hr, overrides: Record<string, Record<string, unknown>> = {}, start?: Parameters<HiringProcessService["start"]>[1]) {
    let p = await hiring.start(claims, start ?? {});
    for (const [cardKey, data] of Object.entries(REQUIRED_PAYLOADS)) {
      await hiring.saveCard(claims, p.id, cardKey, { data: { ...data, ...(overrides[cardKey] ?? {}) } });
    }
    for (let i = 0; i < 30; i++) {
      p = await hiring.get(claims, p.id);
      if (p.status === "ready_for_completion") break;
      p = await hiring.next(claims, p.id, p.revision);
    }
    expect(p.status).toBe("ready_for_completion");
    return p;
  }

  it("CFG-08/09: a new process records its owner, retention date, pinned configuration and first history row; start is idempotent per key", async () => {
    const key = `start-${Date.now()}-key`;
    const p = await hiring.start(hr, { hireReasonCode: "new_position", effectiveHireDate: "2026-11-01", plannedEndDate: "2027-11-01" }, key);
    expect(p).toMatchObject({ status: "draft", ownerUserAccountId: hr.sub, validationState: "unvalidated", effectiveHireDate: "2026-11-01", plannedEndDate: "2027-11-01" });
    expect(new Date(p.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 25 * 86400000);
    const [row] = await sql<{ config_snapshot: { cards: unknown[]; fields: unknown[] } }>("SELECT config_snapshot FROM hire_processes WHERE id = $1", [p.id]);
    expect(row.config_snapshot.cards).toHaveLength(20);
    expect(row.config_snapshot.fields.length).toBeGreaterThan(10);

    const again = await hiring.start(hr, {}, key);
    expect(again.id).toBe(p.id);
    const history = await hiring.getStatusHistory(hr, p.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: "draft", actorUserAccountId: hr.sub });
    await expect(hiring.start(hr, { effectiveHireDate: "2026-11-01", plannedEndDate: "2026-10-01" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("CFG-08: the database refuses transitions outside the state machine, and history is append-only", async () => {
    const p = await hiring.start(hr);
    await expect(sql("UPDATE hire_processes SET status = 'hired' WHERE id = $1", [p.id])).rejects.toThrow(/cannot move from draft to hired/);
    await expect(sql("UPDATE hire_processes SET status = 'approved' WHERE id = $1", [p.id])).rejects.toThrow(/cannot move/);
    await expect(sql("UPDATE hire_process_status_history SET reason = 'x' WHERE hire_process_id = $1", [p.id])).rejects.toThrow(/append-only|permission denied/);
    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "A", lastName: "B" } });
    await hiring.cancel(hr, p.id, (await hiring.get(hr, p.id)).revision);
    await expect(sql("UPDATE hire_processes SET status = 'in_progress' WHERE id = $1", [p.id])).rejects.toThrow(/cannot move from cancelled/);
    const history = await hiring.getStatusHistory(hr, p.id);
    expect(history.map((h) => h.toStatus)).toEqual(["draft", "in_progress", "cancelled"]);
  });

  it("CFG-10: per-card validation state is stored; validate() holds an invalid hire in validation_required and releases it once fixed", async () => {
    const p = await hiring.start(hr);
    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "Zoya", lastName: "Q" } });
    const saved = (await hiring.get(hr, p.id)).cards.find((c) => c.cardKey === "personal_identity")!;
    expect(saved).toMatchObject({ validationState: "valid", status: "complete" });
    expect(saved.completedAt).toBeTruthy();

    // admin tightens the rules after the card was saved
    await cardFields.updateFieldConfig(hr, "personal_identity", "gender", { isRequired: true });
    const result = await hiring.validate(hr, p.id);
    expect(result.validationState).toBe("invalid");
    const bad = result.cards.find((c) => c.cardKey === "personal_identity")!;
    expect(bad.validationState).toBe("invalid");
    expect(bad.errors.join(" ")).toMatch(/gender/i);
    expect((await hiring.get(hr, p.id)).status).toBe("validation_required");
    expect((await hiring.get(hr, p.id)).cards.find((c) => c.cardKey === "personal_identity")!.validationErrors.length).toBeGreaterThan(0);

    await cardFields.updateFieldConfig(hr, "personal_identity", "gender", { isRequired: false });
    const ok = await hiring.validate(hr, p.id);
    expect(ok.cards.find((c) => c.cardKey === "personal_identity")!.validationState).toBe("valid");
    expect((await hiring.get(hr, p.id)).status).toBe("in_progress"); // other required cards still open
  });

  it("CFG-08: with a hiring policy requiring approval, completion needs submit -> approve by a second person; reject reopens", async () => {
    await sql(
      `INSERT INTO hr_business_policies (company_id, policy_type, code, name, rules, is_default) VALUES ($1,'hiring','default','Hiring','{"requireApproval": true}'::jsonb, true)
       ON CONFLICT (company_id, policy_type, code) DO UPDATE SET is_active = true, rules = '{"requireApproval": true}'::jsonb`,
      [companyId]
    );
    const p = await driveToReady(hr);
    await expect(hiring.complete(hr, p.id)).rejects.toThrow(/approval/);
    expect((await hiring.get(hr, p.id)).status).toBe("ready_for_completion"); // a missing approval is not a failure

    await hiring.submit(hr, p.id);
    await expect(hiring.saveCard(hr, p.id, "contact", { data: { x: 1 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(hiring.approve(hr, p.id)).rejects.toBeInstanceOf(ForbiddenException); // maker != checker
    await expect(hiring.reject(hr2, p.id, "")).rejects.toBeInstanceOf(BadRequestException);
    const rejected = await hiring.reject(hr2, p.id, "salary band missing");
    expect(rejected).toMatchObject({ status: "rejected", decisionReason: "salary band missing" });

    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "Hira", lastName: "Fixed" } });
    expect((await hiring.get(hr, p.id)).status).toBe("in_progress");
    let again = await hiring.get(hr, p.id);
    again = await hiring.next(hr, p.id, again.revision);
    for (let i = 0; i < 30 && again.status !== "ready_for_completion"; i++) again = await hiring.next(hr, p.id, again.revision);
    await hiring.submit(hr, p.id);
    const approved = await hiring.approve(hr2, p.id);
    expect(approved).toMatchObject({ status: "approved", decisionReason: null });
    const done = await hiring.complete(hr, p.id);
    expect(done.status).toBe("hired");
    const history = (await hiring.getStatusHistory(hr, p.id)).map((h) => h.toStatus);
    expect(history).toEqual(expect.arrayContaining(["submitted", "rejected", "approved", "hired"]));
  });

  it("CFG-08: a completion that rolls back is recorded as failed with its reason and can be retried to hired", async () => {
    const p = await driveToReady(hr);
    // a reserved number that is void in the ledger can never be issued
    await sql("INSERT INTO employee_numbers (company_id, employee_number, state, voided_at, void_reason, source) VALUES ($1,'EMP-VOID-1','void',now(),'test','manual')", [companyId]);
    await sql("UPDATE hire_processes SET reserved_employee_number = 'EMP-VOID-1' WHERE id = $1", [p.id]);
    await expect(hiring.complete(hr, p.id)).rejects.toBeInstanceOf(ConflictException);
    const failed = await hiring.get(hr, p.id);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/voided/);
    expect(failed.employeeId).toBeNull();

    await sql("UPDATE hire_processes SET reserved_employee_number = NULL WHERE id = $1", [p.id]);
    const retried = await hiring.complete(hr, p.id);
    expect(retried.status).toBe("hired");
    expect(retried.failureReason).toBeNull();
    const again = await hiring.complete(hr, p.id); // idempotent
    expect(again.employeeId).toBe(retried.employeeId);
  });

  it("CFG-09: ownership can be transferred and a delegate set (same-company users only); expired drafts are cancelled, scrubbed and their number voided", async () => {
    await numbering.updatePolicy(hr, { generationTiming: "draft" });
    const p = await hiring.start(hr);
    expect(p.reservedEmployeeNumber).toMatch(/^EMP-/);
    const moved = await hiring.transferOwnership(hr, p.id, hr2.sub!, "covering for leave");
    expect(moved.ownerUserAccountId).toBe(hr2.sub);
    const outsider = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`h5-out-${Date.now()}@example.com`]))[0].id;
    await expect(hiring.transferOwnership(hr, p.id, outsider)).rejects.toBeInstanceOf(BadRequestException);
    expect((await hiring.setDelegate(hr, p.id, hr.sub!)).delegateUserAccountId).toBe(hr.sub);
    expect((await hiring.setDelegate(hr, p.id, null)).delegateUserAccountId).toBeNull();

    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "Old", lastName: "Draft", cnic: "35202-1234567-1" } });
    await sql("UPDATE hire_processes SET expires_at = now() - interval '1 day' WHERE id = $1", [p.id]);
    expect(await hiring.expireStaleDrafts()).toBeGreaterThanOrEqual(1);
    const after = await hiring.get(hr, p.id);
    expect(after.status).toBe("cancelled");
    const [ledger] = await sql<{ state: string }>("SELECT state FROM employee_numbers WHERE company_id = $1 AND employee_number = $2", [companyId, p.reservedEmployeeNumber]);
    expect(ledger.state).toBe("void");
    const history = await hiring.getStatusHistory(hr, p.id);
    expect(history[history.length - 1].reason).toBe("draft expired");
  });

  it("CFG-13: with timing 'draft' the number is reserved at start, issued to the employee at completion; a cancelled hire's number is void and never reused", async () => {
    await numbering.updatePolicy(hr, { generationTiming: "draft" });
    const p = await driveToReady(hr);
    const reserved = p.reservedEmployeeNumber!;
    expect(reserved).toMatch(/^EMP-\d{4}$/);
    const [r1] = await sql<{ state: string; hire_process_id: string }>("SELECT state, hire_process_id FROM employee_numbers WHERE company_id = $1 AND employee_number = $2", [companyId, reserved]);
    expect(r1).toMatchObject({ state: "reserved", hire_process_id: p.id });
    const done = await hiring.complete(hr, p.id);
    const emp = await employees.get(hr, done.employeeId!);
    expect(emp.employeeNumber).toBe(reserved);
    const [r2] = await sql<{ state: string; employee_id: string }>("SELECT state, employee_id FROM employee_numbers WHERE company_id = $1 AND employee_number = $2", [companyId, reserved]);
    expect(r2).toMatchObject({ state: "issued", employee_id: emp.id });

    const q = await hiring.start(hr);
    await hiring.cancel(hr, q.id, q.revision);
    const [r3] = await sql<{ state: string }>("SELECT state FROM employee_numbers WHERE company_id = $1 AND employee_number = $2", [companyId, q.reservedEmployeeNumber]);
    expect(r3.state).toBe("void");
    await expect(employees.create(hr, { firstName: "Reuse", lastName: "Attempt", employeeNumber: q.reservedEmployeeNumber! })).rejects.toBeInstanceOf(ConflictException);
    const next = await employees.create(hr, { firstName: "Next", lastName: "Gen" });
    expect(next.employeeNumber).not.toBe(q.reservedEmployeeNumber);
    await expect(sql("UPDATE employee_numbers SET state = 'reserved' WHERE employee_number = $1 AND company_id = $2", [q.reservedEmployeeNumber, companyId])).rejects.toThrow(/never reused/);
  });

  it("CFG-13: timing 'save' reserves at the first card save; a number reserved for one hire cannot be taken by another", async () => {
    await numbering.updatePolicy(hr, { generationTiming: "save" });
    const p = await hiring.start(hr);
    expect(p.reservedEmployeeNumber).toBeNull();
    await hiring.saveCard(hr, p.id, "personal_identity", { data: { firstName: "S", lastName: "Ave" } });
    const reserved = (await hiring.get(hr, p.id)).reservedEmployeeNumber!;
    expect(reserved).toMatch(/^EMP-/);
    await expect(employees.create(hr, { firstName: "Thief", lastName: "X", employeeNumber: reserved })).rejects.toBeInstanceOf(ConflictException);
    await sql("SELECT 1"); // keep the DB trigger honest too:
    await expect(sql("INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id) SELECT $1, $2, 'T', 'X', (SELECT id FROM persons WHERE company_id = $1 LIMIT 1)", [companyId, reserved])).rejects.toThrow(/reserved for another hiring process/);
  });

  it("CFG-13: concurrent hires always receive distinct numbers", async () => {
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => employees.create(hr, { firstName: `Par${i}`, lastName: "Allel" })));
    const numbers = created.map((e) => e.employeeNumber);
    expect(new Set(numbers).size).toBe(8);
    const ledger = await sql<{ n: string }>("SELECT count(DISTINCT employee_number) n FROM employee_numbers WHERE company_id = $1 AND employee_number = ANY($2)", [companyId, numbers]);
    expect(Number(ledger[0].n)).toBe(8);
  });

  it("CFG-13: yearly series, manual-number rules and the ledger of issued numbers", async () => {
    await numbering.updatePolicy(hr, { resetPolicy: "yearly" });
    const y = await employees.create(hr, { firstName: "Yearly", lastName: "Series" });
    expect(y.employeeNumber).toMatch(new RegExp(`^EMP-${new Date().getFullYear()}-\\d{4}$`));

    await numbering.updatePolicy(hr, { resetPolicy: "never", allowManual: false });
    await expect(employees.create(hr, { firstName: "Man", lastName: "Ual", employeeNumber: "LEGACY-77" })).rejects.toBeInstanceOf(BadRequestException);
    await numbering.updatePolicy(hr, { allowManual: true, manualPattern: "^LEG-\\d+$" });
    await expect(employees.create(hr, { firstName: "Bad", lastName: "Pattern", employeeNumber: "XYZ-1" })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await employees.create(hr, { firstName: "Good", lastName: "Pattern", employeeNumber: "LEG-77" });
    expect(ok.employeeNumber).toBe("LEG-77");
    await expect(employees.create(hr, { firstName: "Dup", lastName: "Number", employeeNumber: "LEG-77" })).rejects.toBeInstanceOf(ConflictException);

    const ledger = await numbering.list(hr, { state: "issued" });
    expect(ledger.find((l) => l.employeeNumber === "LEG-77")).toMatchObject({ source: "manual", employeeId: ok.id });
    expect(ledger.find((l) => l.employeeNumber === y.employeeNumber)).toMatchObject({ source: "generated" });
    await expect(numbering.updatePolicy(hr, { manualPattern: "([" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("CFG-11/12: card and field metadata are stored with validation; references to rules must exist; config_version moves", async () => {
    const before = (await hiring.listCardDefinitions(hr)).find((c) => c.cardKey === "documents")!;
    const after = await hiring.updateCardDefinition(hr, "documents", {
      attachmentRequirement: "required",
      editableAfterSave: false,
      isCompletionGate: false,
      workflowTemplateKey: "hire_documents",
      displayNameI18n: { ur: "دستاویزات" },
      applicabilityRule: { fieldKey: "employmentType", operator: "equals", value: "permanent" },
    });
    expect(after).toMatchObject({ attachmentRequirement: "required", editableAfterSave: false, isCompletionGate: false, workflowTemplateKey: "hire_documents" });
    expect(after.configVersion).toBe(before.configVersion + 1);
    await expect(hiring.updateCardDefinition(hr, "documents", { validationRuleKeys: ["no.such.rule"] })).rejects.toThrow(/unknown or inactive/);
    await sql("INSERT INTO rule_definitions (company_id, rule_key, rule_type, name) VALUES ($1,'hire.doc.required','validation','Docs required')", [companyId]);
    expect((await hiring.updateCardDefinition(hr, "documents", { validationRuleKeys: ["hire.doc.required"] })).validationRuleKeys).toEqual(["hire.doc.required"]);
    await expect(hiring.updateCardDefinition(hr, "documents", { visibilityRule: { ref: "missing" } })).rejects.toThrow(/unknown or inactive/);

    const cnic = (await cardFields.listCardFields(hr, "personal_identity")).builtIn.find((f) => f.fieldKey === "cnic")!;
    expect(cnic).toMatchObject({ label: "CNIC", fieldType: "text", sensitivityClass: "restricted", auditPolicy: "changes" });
    const iban = (await cardFields.listCardFields(hr, "payment_bank")).builtIn.find((f) => f.fieldKey === "iban")!;
    expect(iban.sensitivityClass).toBe("highly_restricted");
    const method = (await cardFields.listCardFields(hr, "payment_bank")).builtIn.find((f) => f.fieldKey === "paymentMethod")!;
    expect(method).toMatchObject({ fieldType: "select", optionValues: ["bank_transfer", "cash", "cheque"] });

    const edited = await cardFields.updateFieldConfig(hr, "personal_identity", "firstName", {
      helpText: "As on the CNIC",
      placeholder: "First name",
      labelI18n: { ur: "پہلا نام" },
      auditPolicy: "reads_and_changes",
      visibilityRule: { fieldKey: "lastName", operator: "notEquals", value: "" },
    });
    expect(edited).toMatchObject({ helpText: "As on the CNIC", auditPolicy: "reads_and_changes", labelI18n: { ur: "پہلا نام" } });
    await expect(cardFields.updateFieldConfig(hr, "personal_identity", "firstName", { fieldType: "select", optionValues: null })).rejects.toBeInstanceOf(BadRequestException);
    await expect(cardFields.updateFieldConfig(hr, "personal_identity", "firstName", { workflowRule: { ref: "missing" } })).rejects.toBeInstanceOf(BadRequestException);
    // a hire started now pins the new metadata version
    const p = await hiring.start(hr);
    const [snap] = await sql<{ config_snapshot: { cards: { cardKey: string; configVersion: number }[] } }>("SELECT config_snapshot FROM hire_processes WHERE id = $1", [p.id]);
    expect(snap.config_snapshot.cards.find((c) => c.cardKey === "documents")!.configVersion).toBeGreaterThan(before.configVersion);
  });
});
