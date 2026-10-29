import { TINY_PNG } from "../testing-tiny-png";
import { Pool, type PoolClient } from "pg";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { EmployeesService } from "../employees/employees.service";
import { LocalFileStorageService } from "../file-storage/local-file-storage.service";
import { RbacService } from "../rbac/rbac.service";
import { CompanyAppearanceService } from "./company-appearance.service";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "company-appearance-spec" };
const png = (n = 7) => {
  const buffer = n <= TINY_PNG.length ? TINY_PNG : Buffer.concat([TINY_PNG, Buffer.alloc(n - TINY_PNG.length, 1)]);
  return { originalname: "banner.png", mimetype: "image/png", buffer, size: buffer.length };
};

/** BACKLOG55 against real Postgres: the company banner setting, who may change it, and the profile photo rule. */
describe("Company appearance and profile photo", () => {
  let pool: Pool;
  let db: DatabaseService;
  let svc: CompanyAppearanceService;
  let employees: EmployeesService;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let a: string;
  let sysAdmin: RequestClaims;
  let hr: RequestClaims;
  let ess: RequestClaims;
  let custom: RequestClaims;
  let me: string;
  const fx = <T>(fn: (c: PoolClient) => Promise<T>) => db.withClaims(FIXTURE, fn);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const ent = new EntitlementsService(db);
    const audit = new AuditService();
    const storage = new LocalFileStorageService();
    svc = new CompanyAppearanceService(db, rbac, audit, storage);
    const cat = { validateActiveCode: async () => undefined } as never;
    employees = new EmployeesService(db, rbac, ent, audit, storage, undefined, undefined, undefined, undefined, undefined, cat);
    await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`CA ${stamp}`, `ca-${stamp}`]);
      a = r.rows[0].id;
      await c.query("INSERT INTO company_config (company_id, enabled_modules) VALUES ($1, $2::jsonb)", [a, JSON.stringify(["employee"])]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [a]);
      const mkUser = async (tag: string, roleKey: string) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`ca-${tag}-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string } as RequestClaims;
      };
      sysAdmin = await mkUser("sys", "system_admin");
      hr = await mkUser("hr", "hr_admin");
      ess = await mkUser("ess", "employee_self_service");
      // a custom role that was given the permission
      const role = await c.query("INSERT INTO roles (key, name, company_id) VALUES ($1, 'Brand manager', $2) RETURNING id", [`cca${stamp.replace(/[^a-z0-9]/g, "").slice(-8)}_brand`, a]);
      await c.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'company_appearance.manage'", [role.rows[0].id]);
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`ca-custom-${stamp}@example.com`]);
      await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
      custom = { is_platform_admin: false, company_id: a, sub: u.rows[0].id as string };
      const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, 'Photo Person') RETURNING id", [a]);
      me = (
        await c.query("INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'P','Q',$3,$4) RETURNING id", [a, `CA-1-${stamp}`.slice(0, 30), p.rows[0].id, ess.sub])
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("starts on the standard banner, and everyone in the company can read the setting", async () => {
    expect(await svc.get(ess)).toMatchObject({ bannerMode: "default", hasBannerImage: false, photoNeedsHrApproval: false });
  });

  it("only System Admin and a role that was given the permission can change it - HR Admin and employees cannot", async () => {
    await expect(svc.update(hr, { bannerMode: "preset", bannerPreset: "ocean" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(ess, { bannerMode: "preset", bannerPreset: "ocean" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.uploadBannerImage(hr, png())).rejects.toBeInstanceOf(ForbiddenException);
    expect((await svc.update(sysAdmin, { bannerMode: "preset", bannerPreset: "ocean" })).bannerPreset).toBe("ocean");
    expect((await svc.update(custom, { bannerMode: "preset", bannerPreset: "forest" })).bannerPreset).toBe("forest");
    expect((await svc.get(ess)).bannerPreset).toBe("forest");
  });

  it("checks every choice: a known style, a colour dark enough for white text, a picture before picture mode", async () => {
    await expect(svc.update(sysAdmin, { bannerMode: "preset", bannerPreset: "nope" as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(sysAdmin, { bannerMode: "color", bannerColor: "#ffff00" })).rejects.toThrow(/too light/);
    await expect(svc.update(sysAdmin, { bannerMode: "color" })).rejects.toThrow(/colour/);
    await expect(svc.update(sysAdmin, { bannerMode: "image" })).rejects.toThrow(/picture/);
    const ok = await svc.update(sysAdmin, { bannerMode: "color", bannerColor: "#1e3a8a" });
    expect(ok).toMatchObject({ bannerMode: "color", bannerColor: "#1e3a8a" });
  });

  it("an uploaded picture is stored, served to everyone, and removing it goes back to the standard banner", async () => {
    await expect(svc.uploadBannerImage(sysAdmin, { originalname: "x.gif", mimetype: "image/gif", buffer: Buffer.from("g"), size: 1 })).rejects.toThrow(/JPEG, PNG or WEBP/);
    await expect(svc.uploadBannerImage(sysAdmin, png(2 * 1024 * 1024 + 1))).rejects.toThrow(/2 MB/);
    const up = await svc.uploadBannerImage(sysAdmin, png(20));
    expect(up.hasBannerImage).toBe(true);
    const shown = await svc.update(sysAdmin, { bannerMode: "image" });
    expect(shown.bannerMode).toBe("image");
    const served = await svc.bannerImage(ess);
    expect(served.mimeType).toBe("image/png");
    expect(served.buffer.length).toBe(TINY_PNG.length);
    const gone = await svc.removeBannerImage(sysAdmin);
    expect(gone).toMatchObject({ hasBannerImage: false, bannerMode: "default" });
    await expect(svc.bannerImage(ess)).rejects.toThrow(/No banner picture/);
  });

  it("each company has its own setting", async () => {
    const other = await fx(async (c) => {
      const r = await c.query("INSERT INTO companies (name, slug, timezone) VALUES ($1, $2, 'Asia/Karachi') RETURNING id", [`CA2 ${stamp}`, `ca2-${stamp}`]);
      const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`ca-o-${stamp}@example.com`]);
      return { is_platform_admin: false, company_id: r.rows[0].id, sub: u.rows[0].id } as RequestClaims;
    });
    expect(await svc.get(other)).toMatchObject({ bannerMode: "default" });
  });

  describe("profile photo", () => {
    const photoOf = async () =>
      (await fx((c) => c.query("SELECT review_status FROM employee_documents WHERE employee_id = $1 AND document_type = 'photograph' ORDER BY created_at DESC LIMIT 1", [me]))).rows[0]?.review_status;

    it("an employee's new photo shows at once by default", async () => {
      await employees.addOwnDocument(ess, me, "photograph", png());
      expect(await photoOf()).toBe("approved");
    });

    it("with the company rule switched on, the employee's photo waits for HR", async () => {
      await svc.update(sysAdmin, { photoNeedsHrApproval: true });
      await employees.addOwnDocument(ess, me, "photograph", png());
      expect(await photoOf()).toBe("pending");
      await svc.update(sysAdmin, { photoNeedsHrApproval: false });
    });

    it("HR changes the photo directly, and a photo has to be an image", async () => {
      await employees.addDocument(hr, me, "photograph", png());
      expect(await photoOf()).toBe("approved");
      await expect(employees.addDocument(hr, me, "photograph", { originalname: "p.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF"), size: 4 })).rejects.toThrow(/JPEG, PNG or WEBP/);
    });

    it("another employee cannot change someone else's photo", async () => {
      const other = await fx(async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`ca-e2-${stamp}@example.com`]);
        const role = await c.query("SELECT id FROM roles WHERE key = 'employee_self_service'");
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, a, role.rows[0].id]);
        const p = await c.query("INSERT INTO persons (company_id, full_name) VALUES ($1, 'Other') RETURNING id", [a]);
        await c.query("INSERT INTO employees (company_id, employee_number, first_name, last_name, person_id, user_account_id) VALUES ($1,$2,'O','T',$3,$4)", [a, `CA-2-${stamp}`.slice(0, 30), p.rows[0].id, u.rows[0].id]);
        return { is_platform_admin: false, company_id: a, sub: u.rows[0].id } as RequestClaims;
      });
      await expect(employees.addOwnDocument(other, me, "photograph", png())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(employees.addDocument(other, me, "photograph", png())).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
