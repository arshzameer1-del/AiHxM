import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysService } from "./api-keys.service";
import { OPENAPI } from "./openapi";
import { PublicApiController } from "./public-api.controller";

describe("Read-only public API", () => {
  let f: PayrollFixture;
  let other: PayrollFixture;
  let keys: ApiKeysService;
  let ctl: PublicApiController;
  let guard: ApiKeyGuard;
  let ess: Awaited<ReturnType<PayrollFixture["makeUser"]>>;

  const ctx = (authorization?: string) => {
    const req: { headers: Record<string, string>; apiKey?: unknown } = { headers: authorization ? { authorization } : {} };
    return { req, ec: { switchToHttp: () => ({ getRequest: () => req }) } as never };
  };

  beforeAll(async () => {
    f = await buildPayrollFixture("api1");
    other = await buildPayrollFixture("api2");
    keys = new ApiKeysService(f.db, f.rbac, f.entitlements, f.audit);
    guard = new ApiKeyGuard(keys);
    ctl = new PublicApiController(f.db);
    ess = await f.makeUser("apie", ["employee_self_service"]);
    await f.createEmployee({ monthlySalary: 90000 });
    await other.createEmployee({ monthlySalary: 1 });
  }, 120000);
  afterAll(async () => {
    await f.cleanup();
    await other.cleanup();
  }, 60000);

  it("only HR manages keys", async () => {
    await expect(keys.list(ess)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(keys.create(ess, "x", ["employees.read"])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a key is shown once, stored only as a hash, and reads only its own company's people without any pay or contact data", async () => {
    await expect(keys.create(f.hr, "", ["employees.read"])).rejects.toBeInstanceOf(BadRequestException);
    await expect(keys.create(f.hr, "x", [])).rejects.toBeInstanceOf(BadRequestException);
    const k = await keys.create(f.hr, "Payroll sync", ["employees.read"]);
    expect(k.secret).toMatch(/^ahx_/);
    const stored = await f.sql<{ key_sha256: string; key_prefix: string }>("SELECT key_sha256, key_prefix FROM api_keys WHERE id = $1", [k.id]);
    expect(stored[0].key_sha256).not.toContain(k.secret);
    expect(stored[0].key_prefix).toBe(k.secret.slice(0, 10));
    expect(JSON.stringify(await keys.list(f.hr))).not.toContain(k.secret);

    const { req, ec } = ctx(`Bearer ${k.secret}`);
    expect(await guard.canActivate(ec)).toBe(true);
    const out = await ctl.employees(req as never, undefined, undefined);
    expect(out.data.length).toBe((await f.sql("SELECT 1 FROM employees WHERE company_id = $1 AND employment_status = 'active'", [f.companyId])).length);
    expect(Object.keys(out.data[0]).sort()).toEqual(["dateOfJoining", "employeeNumber", "firstName", "id", "lastName", "orgUnit", "positionTitle", "status", "terminationDate"]);
    // org.read was not granted
    await expect(ctl.orgUnits(req as never)).rejects.toBeInstanceOf(ForbiddenException);
    const used = await f.sql<{ last_used_at: Date | null }>("SELECT last_used_at FROM api_keys WHERE id = $1", [k.id]);
    expect(used[0].last_used_at).not.toBeNull();
  });

  it("a revoked, unknown or malformed key is refused the same way", async () => {
    const k = await keys.create(f.hr, "Old", ["org.read"]);
    await keys.revoke(f.hr, k.id);
    for (const h of [`Bearer ${k.secret}`, "Bearer ahx_" + "a".repeat(40), "Bearer nonsense", "Basic abc", undefined]) {
      await expect(guard.canActivate(ctx(h).ec)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it("another company's key never sees this company's people", async () => {
    const ok = new ApiKeysService(other.db, other.rbac, other.entitlements, other.audit);
    const k = await ok.create(other.hr, "Theirs", ["employees.read", "org.read"]);
    const { req, ec } = ctx(`Bearer ${k.secret}`);
    await new ApiKeyGuard(ok).canActivate(ec);
    const out = await ctl.employees(req as never, "10", "0", "all");
    const mine = await f.sql<{ id: string }>("SELECT id FROM employees WHERE company_id = $1", [f.companyId]);
    expect(out.data.some((e) => mine.some((m) => m.id === e.id))).toBe(false);
  });

  it("publishes its contract", () => {
    expect(Object.keys(OPENAPI.paths)).toEqual(["/employees", "/org-units"]);
  });
});
