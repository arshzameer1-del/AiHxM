import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { AssetRegisterService } from "./asset-register.service";

/** The asset register lifecycle against real Postgres. */
describe("Asset register", () => {
  let f: PayrollFixture;
  let svc: AssetRegisterService;
  let staff: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let other: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let empA: string;
  let empB: string;
  let n = 0;

  const mk = (over: Record<string, unknown> = {}) =>
    svc.create(f.hr, { assetTag: `LT-${++n}`, name: "Dell Latitude", category: "laptop", ...over } as never);
  const eaRows = (tag: string) => f.sql<{ status: string; employee_id: string }>("SELECT status, employee_id FROM employee_assets WHERE company_id = $1 AND asset_tag = $2 ORDER BY created_at", [f.companyId, tag]);

  beforeAll(async () => {
    f = await buildPayrollFixture("asr1");
    svc = new AssetRegisterService(f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()));
    staff = await f.makeUser("asset-staff", ["employee_self_service"]);
    other = await f.makeUser("asset-other", ["employee_self_service"]);
    empA = (await f.createEmployee({ userAccountId: staff.uid, monthlySalary: null })).id;
    empB = (await f.createEmployee({ userAccountId: other.uid, monthlySalary: null })).id;
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("only HR manages the register; staff are refused", async () => {
    await expect(svc.list(staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create(staff, { assetTag: "X", name: "x", category: "laptop" } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.summary(staff)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("validates the fields and keeps tags unique regardless of case", async () => {
    await expect(svc.create(f.hr, { assetTag: "", name: "x", category: "laptop" } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { assetTag: "A", name: "x", category: "spaceship" } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mk({ purchaseCost: -5 })).rejects.toThrow(/negative/);
    await expect(mk({ purchaseDate: "2026-05-01", warrantyUntil: "2026-01-01" })).rejects.toThrow(/warranty/);
    const a = await mk({ assetTag: "DUP-1" });
    expect(a.status).toBe("in_stock");
    expect(a.history.map((h) => h.eventType)).toEqual(["registered"]);
    await expect(mk({ assetTag: "dup-1" })).rejects.toBeInstanceOf(ConflictException);
    const b = await mk({ assetTag: "DUP-2" });
    await expect(svc.update(f.hr, b.id, { assetTag: "Dup-1" })).rejects.toBeInstanceOf(ConflictException);
    const u = await svc.update(f.hr, b.id, { name: "Renamed", location: "Lahore HQ" });
    expect(u.name).toBe("Renamed");
    expect(u.location).toBe("Lahore HQ");
  });

  it("assign, transfer and return keep the employee's own asset list in step", async () => {
    const a = await mk({ assetTag: "FLOW-1" });
    const assigned = await svc.assign(f.hr, a.id, { employeeId: empA, condition: "good" });
    expect(assigned.status).toBe("assigned");
    expect(assigned.holderId).toBe(empA);
    expect(await eaRows("FLOW-1")).toEqual([{ status: "assigned", employee_id: empA }]);
    await expect(svc.assign(f.hr, a.id, { employeeId: empB })).rejects.toThrow(/already issued/);
    await expect(svc.retire(f.hr, a.id, { disposalMethod: "scrapped" })).rejects.toThrow(/Take the asset back/);

    const moved = await svc.transfer(f.hr, a.id, { employeeId: empB });
    expect(moved.holderId).toBe(empB);
    await expect(svc.transfer(f.hr, a.id, { employeeId: empB })).rejects.toThrow(/already with/);
    expect(await eaRows("FLOW-1")).toEqual([{ status: "returned", employee_id: empA }, { status: "assigned", employee_id: empB }]);
    expect(moved.history.map((h) => h.eventType)).toEqual(["transferred", "assigned", "registered"]);

    const back = await svc.return(f.hr, a.id, { condition: "good" });
    expect(back.status).toBe("in_stock");
    expect(back.holderId).toBeNull();
    expect(await eaRows("FLOW-1")).toEqual([{ status: "returned", employee_id: empA }, { status: "returned", employee_id: empB }]);
    await expect(svc.return(f.hr, a.id, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it("a damaged return goes to maintenance, and maintenance records its cost", async () => {
    const a = await mk({ assetTag: "DMG-1" });
    await svc.assign(f.hr, a.id, { employeeId: empA });
    const r = await svc.return(f.hr, a.id, { condition: "damaged", note: "cracked screen" });
    expect(r.status).toBe("under_maintenance");
    await expect(svc.assign(f.hr, a.id, { employeeId: empA })).rejects.toThrow(/maintenance/);
    await expect(svc.completeMaintenance(f.hr, a.id, { cost: -1 })).rejects.toThrow(/negative/);
    const done = await svc.completeMaintenance(f.hr, a.id, { cost: 12000, note: "new screen" });
    expect(done.status).toBe("in_stock");
    expect(done.history[0]).toMatchObject({ eventType: "maintenance_completed", cost: 12000 });
    await expect(svc.completeMaintenance(f.hr, a.id, {})).rejects.toBeInstanceOf(ConflictException);
    const m = await svc.startMaintenance(f.hr, a.id, {});
    expect(m.status).toBe("under_maintenance");
  });

  it("lost closes the holder's row, found puts it back in stock", async () => {
    const a = await mk({ assetTag: "LOST-1" });
    await svc.assign(f.hr, a.id, { employeeId: empA });
    const lost = await svc.markLost(f.hr, a.id, { note: "stolen" });
    expect(lost.status).toBe("lost");
    expect(lost.holderId).toBeNull();
    expect(await eaRows("LOST-1")).toEqual([{ status: "returned", employee_id: empA }]);
    await expect(svc.assign(f.hr, a.id, { employeeId: empB })).rejects.toThrow(/lost/);
    await expect(svc.markFound(f.hr, (await mk({ assetTag: "LOST-2" })).id, {})).rejects.toThrow(/not marked lost/);
    expect((await svc.markFound(f.hr, a.id, {})).status).toBe("in_stock");
  });

  it("retire needs a disposal method, never a held asset, and is final", async () => {
    const a = await mk({ assetTag: "RET-1" });
    await expect(svc.retire(f.hr, a.id, { disposalMethod: "teleported" as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.retire(f.hr, a.id, { disposalMethod: "sold", disposalValue: -1 })).rejects.toThrow(/negative/);
    const r = await svc.retire(f.hr, a.id, { disposalMethod: "sold", disposalValue: 30000 });
    expect(r.status).toBe("retired");
    expect(r.retiredOn).not.toBeNull();
    expect(r.disposalValue).toBe(30000);
    await expect(svc.retire(f.hr, a.id, { disposalMethod: "sold" })).rejects.toThrow(/Already retired/);
    await expect(svc.assign(f.hr, a.id, { employeeId: empA })).rejects.toThrow(/retired/);
    await expect(svc.markLost(f.hr, a.id, {})).rejects.toBeInstanceOf(ConflictException);
  });

  it("stock-take stamps assets as seen and skips retired ones", async () => {
    const a = await mk({ assetTag: "VER-1" });
    const gone = await mk({ assetTag: "VER-2" });
    await svc.retire(f.hr, gone.id, { disposalMethod: "scrapped" });
    expect(await svc.verify(f.hr, [a.id, gone.id])).toEqual({ verified: 1 });
    expect((await svc.get(f.hr, a.id)).lastVerifiedOn).not.toBeNull();
    expect((await svc.get(f.hr, gone.id)).lastVerifiedOn).toBeNull();
    await expect(svc.verify(f.hr, [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the holder sees only their own assets and confirms receipt once", async () => {
    const a = await mk({ assetTag: "MINE-1" });
    await svc.assign(f.hr, a.id, { employeeId: empA, condition: "new" });
    const mine = (await svc.mine(staff)).filter((x) => x.assetTag === "MINE-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ condition: "new", acknowledgedAt: null });
    expect((await svc.mine(other)).filter((x) => x.assetTag === "MINE-1")).toHaveLength(0);

    await expect(svc.acknowledge(other, mine[0].eventId)).rejects.toBeInstanceOf(NotFoundException);
    await svc.acknowledge(staff, mine[0].eventId);
    expect((await svc.mine(staff)).find((x) => x.assetTag === "MINE-1")?.acknowledgedAt).not.toBeNull();
    await expect(svc.acknowledge(staff, mine[0].eventId)).rejects.toBeInstanceOf(NotFoundException);

    await svc.return(f.hr, a.id, {});
    expect((await svc.mine(staff)).filter((x) => x.assetTag === "MINE-1")).toHaveLength(0);
  });

  it("the employee is told about an issue, and heldBy and summary report the truth", async () => {
    const a = await mk({ assetTag: "HELD-1", purchaseCost: 150000, warrantyUntil: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) });
    await svc.assign(f.hr, a.id, { employeeId: empB });
    const notes = await f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1 AND title LIKE 'Asset issued%'", [other.uid]);
    expect(notes.length).toBeGreaterThan(0);
    expect((await svc.heldBy(f.hr, empB)).map((x) => x.assetTag)).toContain("HELD-1");
    expect((await svc.heldBy(f.hr, empA)).map((x) => x.assetTag)).not.toContain("HELD-1");
    const s = await svc.summary(f.hr);
    expect(s.total).toBeGreaterThan(5);
    expect(s.byStatus.assigned).toBeGreaterThanOrEqual(1);
    expect(s.warrantyExpiringSoon).toBeGreaterThanOrEqual(1);
    expect(s.totalPurchaseCost).toBeGreaterThanOrEqual(150000);
    const found = await svc.list(f.hr, { q: "held-1" });
    expect(found.map((x) => x.assetTag)).toEqual(["HELD-1"]);
    expect((await svc.list(f.hr, { status: "retired" })).every((x) => x.status === "retired")).toBe(true);
  });
});
