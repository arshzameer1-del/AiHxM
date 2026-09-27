import { Pool } from "pg";
import { BadRequestException, ConflictException } from "@nestjs/common";
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
import { EmployeeCostAllocationsService } from "../employee-cost-allocations.service";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { HiringProcessService } from "./hiring-process.service";
import { CardFieldConfigService } from "./card-field-config.service";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hiring-spec-fixtures" };

/**
 * Core Employee Enterprise Phase 2 — real Postgres, no mocks, the same
 * discipline employees.service.spec.ts already established for this
 * module.
 */
describe("HiringProcessService", () => {
  let pool: Pool;
  let db: DatabaseService;
  let hiring: HiringProcessService;
  let companyId: string;
  let hrAdminClaims: RequestClaims;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    const employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
    const shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    const compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());
    hiring = new HiringProcessService(
      db,
      rbac,
      entitlements,
      audit,
      employees,
      undefined,
      undefined,
      undefined,
      shifts,
      undefined,
      undefined,
      compensation
    );

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Hiring Spec Co ${stamp}`,
        `hiring-spec-co-${stamp}`,
      ]);
      const id = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [id]
      );
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      // Phase 7 — Working Time card fixtures create a real Shift via
      // ShiftsService.createShift(), which is gated on the `leave` module
      // (0026_shift_management.sql's own entitlement choice — shifts are
      // licensed under Leave, not Employee).
      await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'leave', true)", [id]);
      return id as string;
    });
    const user = await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`hiring-hr-${stamp}@example.com`])
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

  it("starts a hire process seeded with the full 20-card catalogue, first enabled card first", async () => {
    const process = await hiring.start(hrAdminClaims);
    expect(process.status).toBe("draft");
    expect(process.cards).toHaveLength(20);
    expect(process.currentCardKey).toBe("personal_identity");
    expect(process.cards.every((c) => c.status === "pending")).toBe(true);
  });

  it("moves in_progress on the first card save, and marks a required card complete only once it holds real data", async () => {
    const process = await hiring.start(hrAdminClaims);
    const saved = await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "Ayesha", lastName: "Khan" } });
    expect(saved.status).toBe("complete");

    const reloaded = await hiring.get(hrAdminClaims, process.id);
    expect(reloaded.status).toBe("in_progress");
  });

  it("rejects a stale card save with a conflicting revision", async () => {
    const process = await hiring.start(hrAdminClaims);
    await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "A", lastName: "B" } });
    await expect(
      hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "C", lastName: "D" }, expectedRevision: 0 })
    ).rejects.toThrow(ConflictException);
  });

  it("refuses to advance past a required card that isn't complete yet", async () => {
    const process = await hiring.start(hrAdminClaims);
    await expect(hiring.next(hrAdminClaims, process.id, process.revision)).rejects.toThrow(BadRequestException);
  });

  it("runs a full hire end to end: every required card, next through the deck, complete creates a real employee, and completion is idempotent", async () => {
    let process = await hiring.start(hrAdminClaims);

    const requiredCards = process.cards.filter((c) => c.definition.isRequired).map((c) => c.cardKey);
    expect(requiredCards).toEqual(["personal_identity", "employment", "organization_assignment", "review_completion"]);

    const cardPayloads: Record<string, Record<string, unknown>> = {
      personal_identity: { firstName: "Bilal", lastName: "Ahmed", cnic: `${Date.now()}-HIRE` },
      employment: { employmentType: "permanent", dateOfJoining: "2026-01-01" },
      organization_assignment: { note: "HQ" },
      review_completion: { reviewed: true },
    };

    for (let i = 0; i < process.cards.length; i++) {
      const card = process.cards[i];
      if (cardPayloads[card.cardKey]) {
        await hiring.saveCard(hrAdminClaims, process.id, card.cardKey, { data: cardPayloads[card.cardKey] });
      }
      process = await hiring.get(hrAdminClaims, process.id);
      if (i < process.cards.length - 1) {
        process = await hiring.next(hrAdminClaims, process.id, process.revision);
      }
    }
    // Final Next() call happens for the last card too, inside the loop's `next` branch guard — but since
    // the loop condition skips Next after the LAST card, do it explicitly here to reach ready_for_completion.
    process = await hiring.next(hrAdminClaims, process.id, process.revision);
    expect(process.status).toBe("ready_for_completion");

    const completed = await hiring.complete(hrAdminClaims, process.id);
    expect(completed.status).toBe("hired");
    expect(completed.employeeId).not.toBeNull();

    const employeeIdAfterFirstComplete = completed.employeeId;
    const completedAgain = await hiring.complete(hrAdminClaims, process.id);
    expect(completedAgain.employeeId).toBe(employeeIdAfterFirstComplete);
  });

  it("cancels a draft and refuses further card saves on it", async () => {
    const process = await hiring.start(hrAdminClaims);
    const cancelled = await hiring.cancel(hrAdminClaims, process.id, process.revision);
    expect(cancelled.status).toBe("cancelled");
    await expect(hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "X", lastName: "Y" } })).rejects.toThrow(
      BadRequestException
    );
  });

  it("Configuration Center: disabling a card removes it from a new process, and it can be re-enabled", async () => {
    await hiring.updateCardDefinition(hrAdminClaims, "benefits", { isEnabled: false });
    const process = await hiring.start(hrAdminClaims);
    expect(process.cards.find((c) => c.cardKey === "benefits")).toBeUndefined();

    await hiring.updateCardDefinition(hrAdminClaims, "benefits", { isEnabled: true });
    const definitions = await hiring.listCardDefinitions(hrAdminClaims);
    expect(definitions.find((d) => d.cardKey === "benefits")?.isEnabled).toBe(true);
  });

  describe("Phase 5 — Organization Assignment card: Section 15 Assignment Validation Matrix", () => {
    async function createOrgUnit(status: "active" | "archived" = "active") {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO org_units (company_id, unit_type, name, status) VALUES ($1, 'department', $2, $3) RETURNING id",
          [companyId, `Org Unit ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]
        );
        return result.rows[0].id as string;
      });
    }

    async function createPosition(orgUnitId: string, status: "vacant" | "filled" | "frozen" | "abolished" = "vacant") {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO positions (company_id, org_unit_id, position_title, status) VALUES ($1, $2, $3, $4) RETURNING id",
          [companyId, orgUnitId, `Position ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]
        );
        return result.rows[0].id as string;
      });
    }

    async function createLocation(status: "active" | "archived" = "active") {
      return db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO locations (company_id, location_type, name, status) VALUES ($1, 'site', $2, $3) RETURNING id",
          [companyId, `Location ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status]
        );
        return result.rows[0].id as string;
      });
    }

    it("rejects an org unit assignment card when the org unit is archived", async () => {
      const process = await hiring.start(hrAdminClaims);
      const archivedOrgUnit = await createOrgUnit("archived");
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: archivedOrgUnit } })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an assignment to an already-occupied, frozen, or abolished position", async () => {
      const process = await hiring.start(hrAdminClaims);
      const orgUnit = await createOrgUnit();
      const filledPosition = await createPosition(orgUnit, "filled");
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnit, positionId: filledPosition } })
      ).rejects.toThrow(BadRequestException);

      const frozenPosition = await createPosition(orgUnit, "frozen");
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnit, positionId: frozenPosition } })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a position that belongs to a different org unit than the one selected", async () => {
      const process = await hiring.start(hrAdminClaims);
      const orgUnitA = await createOrgUnit();
      const orgUnitB = await createOrgUnit();
      const positionInB = await createPosition(orgUnitB, "vacant");
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnitA, positionId: positionInB } })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an archived location", async () => {
      const process = await hiring.start(hrAdminClaims);
      const orgUnit = await createOrgUnit();
      const archivedLocation = await createLocation("archived");
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnit, locationId: archivedLocation } })
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an assignment effective date before the employment date of joining", async () => {
      const process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-06-01" } });
      const orgUnit = await createOrgUnit();
      await expect(
        hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", {
          data: { orgUnitId: orgUnit, effectiveFrom: "2026-05-01" },
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("accepts a valid vacant position in a matching, active org unit and location", async () => {
      const process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-01-01" } });
      const orgUnit = await createOrgUnit();
      const position = await createPosition(orgUnit, "vacant");
      const location = await createLocation("active");
      const saved = await hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", {
        data: { orgUnitId: orgUnit, positionId: position, locationId: location, effectiveFrom: "2026-01-01" },
      });
      expect(saved.status).toBe("complete");
    });
  });

  describe("Phase 6 — Reporting Relationships / Contact / Addresses cards project onto the new employee at completion", () => {
    it("maps the org unit, direct manager, contacts and addresses onto the new employee's own record and sub-entity tables", async () => {
      const orgUnit = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id", [
          companyId,
          `Phase6 Org Unit ${Date.now()}`,
        ]);
        return result.rows[0].id as string;
      });
      const managerId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1, $2, 'Manager', 'One') RETURNING id",
          [companyId, `MGR-${Date.now()}`]
        );
        return result.rows[0].id as string;
      });

      let process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "Sana", lastName: "Tariq" } });
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-02-01" } });
      await hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnit } });
      await hiring.saveCard(hrAdminClaims, process.id, "reporting_relationships", { data: { directManagerEmployeeId: managerId } });
      await hiring.saveCard(hrAdminClaims, process.id, "contact", {
        data: { contacts: [{ contactType: "personal_email", value: "sana@example.com", isPrimary: true }] },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "addresses", {
        data: { addresses: [{ addressType: "current", line1: "House 12, Street 5", city: "Karachi" }] },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiring.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiring.next(hrAdminClaims, process.id, process.revision);
      }
      expect(process.status).toBe("ready_for_completion");

      const completed = await hiring.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
      const employeeId = completed.employeeId as string;

      const { orgUnitId, managerIdOnEmployee, contactRows, addressRows } = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const employeeRow = await client.query("SELECT org_unit_id, manager_id FROM employees WHERE id = $1", [employeeId]);
        const contacts = await client.query("SELECT * FROM employee_contacts WHERE employee_id = $1", [employeeId]);
        const addresses = await client.query("SELECT * FROM employee_addresses WHERE employee_id = $1", [employeeId]);
        return {
          orgUnitId: employeeRow.rows[0].org_unit_id,
          managerIdOnEmployee: employeeRow.rows[0].manager_id,
          contactRows: contacts.rows,
          addressRows: addresses.rows,
        };
      });

      expect(orgUnitId).toBe(orgUnit);
      expect(managerIdOnEmployee).toBe(managerId);
      expect(contactRows).toHaveLength(1);
      expect(contactRows[0].value).toBe("sana@example.com");
      expect(contactRows[0].is_primary).toBe(true);
      expect(addressRows).toHaveLength(1);
      expect(addressRows[0].city).toBe("Karachi");
    });
  });

  describe("Phase 7 — Working Time / Important Dates cards project onto shift_assignments and employee_important_dates at completion", () => {
    it("assigns the selected shift and records every important date entered on the card", async () => {
      const shift = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const result = await client.query(
          "INSERT INTO shifts (company_id, name, start_time, end_time) VALUES ($1, $2, '09:00', '17:00') RETURNING id",
          [companyId, `Phase7 Shift ${Date.now()}`]
        );
        return result.rows[0].id as string;
      });

      let process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "Imran", lastName: "Qureshi" } });
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-03-01" } });
      await hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { note: "no org unit needed for this test" } });
      await hiring.saveCard(hrAdminClaims, process.id, "working_time", { data: { shiftId: shift } });
      await hiring.saveCard(hrAdminClaims, process.id, "important_dates", {
        data: { dates: [{ dateType: "probation_end", dateValue: "2026-06-01" }, { dateType: "document_expiry", dateValue: "2027-01-01", label: "CNIC" }] },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiring.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiring.next(hrAdminClaims, process.id, process.revision);
      }
      expect(process.status).toBe("ready_for_completion");

      const completed = await hiring.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
      const employeeId = completed.employeeId as string;

      const { assignmentRows, dateRows } = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const assignments = await client.query("SELECT * FROM shift_assignments WHERE employee_id = $1", [employeeId]);
        const dates = await client.query(
          "SELECT * FROM employee_important_dates WHERE employee_id = $1 ORDER BY date_type",
          [employeeId]
        );
        return { assignmentRows: assignments.rows, dateRows: dates.rows };
      });

      expect(assignmentRows).toHaveLength(1);
      expect(assignmentRows[0].shift_id).toBe(shift);
      expect(dateRows).toHaveLength(2);
      expect(dateRows.map((r) => r.date_type)).toEqual(["document_expiry", "probation_end"]);
    });
  });

  describe("Phase 8 — Compensation / Payment-Bank / Cost Allocation cards project onto employee_compensation, employee_payment_accounts and employee_cost_allocations at completion", () => {
    it("sets the starting salary, records the primary payment account, and splits cost allocation across two cost centers", async () => {
      const [orgUnit, costCenterA, costCenterB] = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const unit = await client.query("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1, 'department', $2) RETURNING id", [
          companyId,
          `Phase8 Org Unit ${Date.now()}`,
        ]);
        const ccA = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [
          companyId,
          `Phase8 CC A ${Date.now()}`,
        ]);
        const ccB = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [
          companyId,
          `Phase8 CC B ${Date.now()}`,
        ]);
        return [unit.rows[0].id as string, ccA.rows[0].id as string, ccB.rows[0].id as string];
      });

      let process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "Hina", lastName: "Malik" } });
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-04-01" } });
      await hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { orgUnitId: orgUnit } });
      await hiring.saveCard(hrAdminClaims, process.id, "compensation", { data: { monthlySalary: 150000 } });
      await hiring.saveCard(hrAdminClaims, process.id, "payment_bank", {
        data: { paymentMethod: "bank_transfer", bankName: "HBL", accountNumber: "1234567890", iban: "PK00HABB0000123456789" },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "cost_allocation", {
        data: {
          allocations: [
            { costCenterId: costCenterA, allocationPercentage: 60, isPrimary: true },
            { costCenterId: costCenterB, allocationPercentage: 40 },
          ],
        },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiring.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiring.next(hrAdminClaims, process.id, process.revision);
      }
      expect(process.status).toBe("ready_for_completion");

      const completed = await hiring.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
      const employeeId = completed.employeeId as string;

      const { compensationRows, paymentRows, allocationRows } = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        // Payroll Phase P1 (2026-09-27) retired `employee_compensation` as a
        // live write target — the Hiring Wizard's "compensation" card still
        // calls EmployeeCompensationService.setCompensationWithinTransaction()
        // (Core Employee's own master data as of a later 2026-09-27
        // architecture correction — see that service's own doc comment)
        // with the same {monthlySalary, effectiveFrom} shape, but that
        // targets ONLY the "basic_salary" row in the component-based
        // `employee_compensation_components` table (see
        // claude/payroll-enterprise-gap-analysis-and-roadmap.md). The old
        // table is kept as a frozen historical record, not written to by
        // new hires, so this test reads the new table instead.
        const compensation = await client.query(
          `SELECT ecc.amount FROM employee_compensation_components ecc
           JOIN compensation_components cc ON cc.id = ecc.component_id
           WHERE ecc.employee_id = $1 AND cc.key = 'basic_salary' AND ecc.effective_to IS NULL`,
          [employeeId]
        );
        const payments = await client.query("SELECT * FROM employee_payment_accounts WHERE employee_id = $1", [employeeId]);
        const allocations = await client.query(
          "SELECT * FROM employee_cost_allocations WHERE employee_id = $1 ORDER BY allocation_percentage DESC",
          [employeeId]
        );
        return { compensationRows: compensation.rows, paymentRows: payments.rows, allocationRows: allocations.rows };
      });

      expect(compensationRows).toHaveLength(1);
      expect(Number(compensationRows[0].amount)).toBe(150000);
      expect(paymentRows).toHaveLength(1);
      expect(paymentRows[0].bank_name).toBe("HBL");
      expect(paymentRows[0].is_primary).toBe(true);
      expect(allocationRows).toHaveLength(2);
      expect(Number(allocationRows[0].allocation_percentage)).toBe(60);
      expect(allocationRows[0].is_primary).toBe(true);
      expect(Number(allocationRows[1].allocation_percentage)).toBe(40);
    });

    it("rejects a cost allocation split that would exceed 100% for the same employee", async () => {
      const { employeeId, costCenterA, costCenterB } = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const emp = await client.query(
          "INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1, $2, 'Split', 'Test') RETURNING id",
          [companyId, `SPLIT-${Date.now()}`]
        );
        const ccA = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [
          companyId,
          `Phase8 Overflow CC A ${Date.now()}`,
        ]);
        const ccB = await client.query("INSERT INTO cost_centers (company_id, name) VALUES ($1, $2) RETURNING id", [
          companyId,
          `Phase8 Overflow CC B ${Date.now()}`,
        ]);
        return { employeeId: emp.rows[0].id as string, costCenterA: ccA.rows[0].id as string, costCenterB: ccB.rows[0].id as string };
      });

      const costAllocations = new EmployeeCostAllocationsService(db, new RbacService(db), new EntitlementsService(db), new AuditService());
      await costAllocations.create(hrAdminClaims, { employeeId, costCenterId: costCenterA, allocationPercentage: 70 });
      await expect(
        costAllocations.create(hrAdminClaims, { employeeId, costCenterId: costCenterB, allocationPercentage: 40 })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("Phase 9 — Family / Education / Qualifications / Assets cards project onto their own list tables at completion", () => {
    it("records every family member, education entry, qualification and asset entered on their cards", async () => {
      let process = await hiring.start(hrAdminClaims);
      await hiring.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "Farah", lastName: "Siddiqui" } });
      await hiring.saveCard(hrAdminClaims, process.id, "employment", { data: { employmentType: "permanent", dateOfJoining: "2026-05-01" } });
      await hiring.saveCard(hrAdminClaims, process.id, "organization_assignment", { data: { note: "no org unit needed for this test" } });
      await hiring.saveCard(hrAdminClaims, process.id, "family_dependents", {
        data: {
          members: [
            { relationship: "spouse", fullName: "Ali Siddiqui", isDependent: true, isBeneficiary: true },
            { relationship: "child", fullName: "Zara Siddiqui", isDependent: true },
          ],
        },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "education", {
        data: { entries: [{ degreeTitle: "BSc Computer Science", institution: "FAST NUCES", startDate: "2016-09-01", endDate: "2020-06-01" }] },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "qualifications_skills", {
        data: {
          items: [
            { qualificationType: "certificate", title: "PMP", issuingAuthority: "PMI" },
            { qualificationType: "skill", title: "TypeScript", proficiencyLevel: "advanced" },
          ],
        },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "assets", {
        data: { items: [{ assetType: "laptop", assetTag: "LT-1001", description: "Dell Latitude" }] },
      });
      await hiring.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiring.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiring.next(hrAdminClaims, process.id, process.revision);
      }
      expect(process.status).toBe("ready_for_completion");

      const completed = await hiring.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
      const employeeId = completed.employeeId as string;

      const { familyRows, educationRows, qualificationRows, assetRows } = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const family = await client.query("SELECT * FROM employee_family_members WHERE employee_id = $1 ORDER BY relationship", [
          employeeId,
        ]);
        const education = await client.query("SELECT * FROM employee_education WHERE employee_id = $1", [employeeId]);
        const qualifications = await client.query(
          "SELECT * FROM employee_qualifications WHERE employee_id = $1 ORDER BY qualification_type",
          [employeeId]
        );
        const assets = await client.query("SELECT * FROM employee_assets WHERE employee_id = $1", [employeeId]);
        return { familyRows: family.rows, educationRows: education.rows, qualificationRows: qualifications.rows, assetRows: assets.rows };
      });

      expect(familyRows).toHaveLength(2);
      expect(familyRows.map((r) => r.relationship)).toEqual(["child", "spouse"]);
      expect(familyRows.find((r) => r.relationship === "spouse")?.is_beneficiary).toBe(true);
      expect(educationRows).toHaveLength(1);
      expect(educationRows[0].degree_title).toBe("BSc Computer Science");
      expect(qualificationRows).toHaveLength(2);
      expect(qualificationRows.map((r) => r.qualification_type)).toEqual(["certificate", "skill"]);
      expect(assetRows).toHaveLength(1);
      expect(assetRows[0].asset_tag).toBe("LT-1001");
      expect(assetRows[0].status).toBe("assigned");
    });
  });

  describe("Hiring Card Field Configuration — a custom field added to a hiring card is copied onto the employee at completion", () => {
    let hiringWithCustomFields: HiringProcessService;
    let cardFields: CardFieldConfigService;
    let customFields: CustomFieldsService;

    beforeAll(() => {
      const rbac = new RbacService(db);
      const entitlements = new EntitlementsService(db);
      const audit = new AuditService();
      const employees = new EmployeesService(db, rbac, entitlements, audit, new LocalFileStorageService());
      customFields = new CustomFieldsService(db, rbac);
      cardFields = new CardFieldConfigService(db, rbac, entitlements, audit, customFields);
      // Same instance shape as the outer `hiring`, but with a real
      // CustomFieldsService wired in at the very end — the outer `hiring`
      // deliberately leaves it undefined so every OTHER test in this file
      // stays unaffected by this feature.
      hiringWithCustomFields = new HiringProcessService(
        db,
        rbac,
        entitlements,
        audit,
        employees,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        customFields
      );
    });

    it("mirrors a custom field added to the Personal Identity card onto the employee's own profile (objectKey 'employee')", async () => {
      await cardFields.addCustomField(hrAdminClaims, "personal_identity", {
        fieldKey: "favoriteColor",
        label: "Favorite color",
        fieldType: "text",
      });

      let process = await hiringWithCustomFields.start(hrAdminClaims);
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "personal_identity", {
        data: { firstName: "Bilal", lastName: "Rana", __customFields: { favoriteColor: "Green" } },
      });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "employment", {
        data: { employmentType: "permanent", dateOfJoining: "2026-06-01" },
      });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "organization_assignment", {
        data: { note: "no org unit needed for this test" },
      });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiringWithCustomFields.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiringWithCustomFields.next(hrAdminClaims, process.id, process.revision);
      }
      expect(process.status).toBe("ready_for_completion");

      const completed = await hiringWithCustomFields.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
      const employeeId = completed.employeeId as string;

      const employeeValues = await customFields.getValues(hrAdminClaims, "employee", employeeId);
      expect(employeeValues.favoriteColor).toBe("Green");

      // The card-scoped definition (what the live Hiring Wizard reads)
      // and its `employee`-scope mirror (what the Employee Detail page
      // reads afterward) both exist — kumail's own "Wizard + Employee
      // profile" scope choice.
      const cardScoped = await cardFields.listCardFields(hrAdminClaims, "personal_identity");
      expect(cardScoped.custom.map((f) => f.fieldKey)).toContain("favoriteColor");
      const employeeScoped = await customFields.listDefinitions(hrAdminClaims, "employee");
      expect(employeeScoped.map((f) => f.fieldKey)).toContain("favoriteColor");
    });

    it("skips a card with no __customFields entry without error", async () => {
      let process = await hiringWithCustomFields.start(hrAdminClaims);
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "personal_identity", { data: { firstName: "No", lastName: "Custom" } });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "employment", {
        data: { employmentType: "permanent", dateOfJoining: "2026-06-02" },
      });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "organization_assignment", {
        data: { note: "no org unit needed for this test" },
      });
      await hiringWithCustomFields.saveCard(hrAdminClaims, process.id, "review_completion", { data: { reviewed: true } });

      process = await hiringWithCustomFields.get(hrAdminClaims, process.id);
      for (let i = 0; i < process.cards.length; i++) {
        process = await hiringWithCustomFields.next(hrAdminClaims, process.id, process.revision);
      }

      const completed = await hiringWithCustomFields.complete(hrAdminClaims, process.id);
      expect(completed.status).toBe("hired");
    });
  });
});
