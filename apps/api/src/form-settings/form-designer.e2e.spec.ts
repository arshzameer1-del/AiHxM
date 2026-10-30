import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "form-designer-fixtures" };

/** The form designer through the real HTTP surface: draft, publish, the rules the server keeps, custom fields, and reset. */
describe("Form designer (HTTP)", () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let hr: string;
  let ess: string;
  let employeeId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const api = (method: "get" | "put" | "post" | "patch" | "delete", path: string, token = hr) => request(app.getHttpServer())[method](path).set("Authorization", `Bearer ${token}`);

  const sign = (sub: string) => jwt.sign({ sub, is_platform_admin: false, company_id: companyId }, process.env.JWT_SECRET as string, { expiresIn: "10m" });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    companyId = await db.withClaims(FIXTURE_CLAIMS, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug, status) VALUES ($1, $2, 'active') RETURNING id", [`Designer Co ${stamp}`, `designer-${stamp}`]);
      const id = co.rows[0].id as string;
      await c.query(`INSERT INTO company_config (company_id, enabled_modules, employee_number_format) VALUES ($1, '["employee"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`, [id]);
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, 'employee', true)", [id]);
      return id;
    });
    const mk = async (role: string, tag: string) =>
      db.withClaims(FIXTURE_CLAIMS, async (c) => {
        const u = await c.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [`designer-${tag}-${stamp}@example.com`]);
        const r = await c.query("SELECT id FROM roles WHERE key = $1", [role]);
        await c.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [u.rows[0].id, companyId, r.rows[0].id]);
        return u.rows[0].id as string;
      });
    hr = sign(await mk("hr_admin", "hr"));
    ess = sign(await mk("employee_self_service", "ess"));
    const created = await api("post", "/employees").send({ firstName: "Design", lastName: "Target", dateOfJoining: "2024-03-01", employmentType: "permanent" });
    expect(created.status).toBe(201);
    employeeId = created.body.id;
  }, 120000);

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
    await app.close();
  });

  it("only people who manage employees can design; everyone signed in can read the live layout", async () => {
    expect((await api("get", "/form-layouts/employee_profile/designer", ess)).status).toBe(403);
    expect((await api("put", "/form-layouts/employee_profile/draft", ess).send({ layout: { sections: [] } })).status).toBe(403);
    expect((await api("post", "/form-layouts/employee_profile/publish", ess)).status).toBe(403);
    const view = await api("get", "/form-layouts/employee_profile", ess);
    expect(view.status).toBe(200);
    expect(view.body.layout).toBeNull();
    expect((await api("get", "/form-layouts/not_a_form")).status).toBe(404);
  });

  it("starts as the form's own default with a suggested grouping, and nothing live", async () => {
    const d = (await api("get", "/form-layouts/employee_profile/designer")).body;
    expect(d.livePublished).toBe(false);
    expect(d.hasDraft).toBe(false);
    expect(d.defaultLayout.sections).toHaveLength(1);
    expect(d.suggestedLayout.sections.map((s: { title: string }) => s.title)).toEqual(["Personal information", "Contact", "Employment", "Pay and bank"]);
    expect(d.settings.fields.length).toBeGreaterThan(10);
    expect(d.customObjectKey).toBe("employee");
  });

  it("a layout with a custom field: draft is not live until published, and the server keeps the rules", async () => {
    const def = await api("post", "/custom-fields/definitions").send({ objectKey: "employee", fieldKey: "badge_number", label: "Badge number", fieldType: "text" });
    expect(def.status).toBe(201);
    const sel = await api("post", "/custom-fields/definitions").send({ objectKey: "employee", fieldKey: "shirt_size", label: "Shirt size", fieldType: "select", options: ["S", "M", "L"] });
    expect(sel.status).toBe(201);

    const design = (await api("get", "/form-layouts/employee_profile/designer")).body;
    const sections = design.suggestedLayout.sections.map((s: { key: string; fields: object[] }) => ({ ...s }));
    const edit = (key: string, extra: object) => sections.forEach((s: { fields: Array<{ key: string }> }) => { s.fields = s.fields.map((f) => (f.key === key ? { ...f, ...extra } : f)); });
    sections[2].fields = [...sections[2].fields, { key: "badge_number", custom: true, requiredWhen: { field: "employmentType", op: "equals", value: "contract" } }, { key: "shirt_size", custom: true, showWhen: { field: "employmentStatus", op: "equals", value: "active" } }];
    edit("cnic", { readOnly: true });
    const saved = await api("put", "/form-layouts/employee_profile/draft").send({ layout: { sections } });
    expect([saved.status, saved.body.hasDraft, saved.body.livePublished]).toEqual([200, true, false]);
    expect((await api("get", "/form-layouts/employee_profile", ess)).body.layout).toBeNull();

    const pub = await api("post", "/form-layouts/employee_profile/publish");
    expect([pub.status, pub.body.livePublished, pub.body.hasDraft, pub.body.version]).toEqual([200, true, false, 1]);
    const live = (await api("get", "/form-layouts/employee_profile", ess)).body;
    expect(live.layout.sections).toHaveLength(4);
    expect(live.customFields.map((c: { key: string }) => c.key)).toEqual(["badge_number", "shirt_size"]);

    // required-when: contract staff need a badge number
    const noBadge = await api("patch", `/employees/${employeeId}`).send({ employmentType: "contract" });
    expect(noBadge.status).toBe(400);
    expect(noBadge.body.message?.message ?? noBadge.body.message).toBe('Badge number is required when Employment type is "contract"');
    const withBadge = await api("patch", `/employees/${employeeId}`).send({ employmentType: "contract", customFields: { badge_number: "B-77" } });
    expect(withBadge.status).toBe(200);
    expect((await api("get", `/custom-fields/values?objectKey=employee&recordId=${employeeId}`)).body.badge_number).toBe("B-77");
    // a later edit of something else is not blocked, because the badge is already saved
    expect((await api("patch", `/employees/${employeeId}`).send({ phone: "0300-1234567" })).status).toBe(200);

    // read-only field cannot be changed through the API either
    const ro = await api("patch", `/employees/${employeeId}`).send({ cnic: "35202-1234567-1" });
    expect(ro.status).toBe(400);
    expect(JSON.stringify(ro.body)).toContain("CNIC is read-only on this form");

    // custom values are checked: wrong option, unknown field
    expect((await api("patch", `/employees/${employeeId}`).send({ customFields: { shirt_size: "XXL" } })).status).toBe(400);
    expect((await api("patch", `/employees/${employeeId}`).send({ customFields: { nope: "x" } })).status).toBe(400);
    expect((await api("patch", `/employees/${employeeId}`).send({ customFields: { shirt_size: "L" } })).status).toBe(200);
  });

  it("a bad layout is refused with a clear 400 and the live one is untouched", async () => {
    const live = (await api("get", "/form-layouts/employee_profile")).body.layout;
    const fields = (await api("get", "/form-layouts/employee_profile/designer")).body.defaultLayout.sections[0].fields;
    const tries: Array<[string, object, string]> = [
      ["removing an always-needed field", { sections: [{ key: "a", title: "", fields: fields.filter((f: { key: string }) => f.key !== "lastName") }] }, "cannot be removed"],
      ["a field twice", { sections: [{ key: "a", title: "", fields: [...fields, { key: "phone" }] }] }, "placed twice"],
      ["a custom field that does not exist", { sections: [{ key: "a", title: "", fields: [...fields, { key: "ghost", custom: true }] }] }, "not one of your custom fields"],
      ["no sections", { sections: [] }, "at least one section"],
    ];
    for (const [name, layout, expected] of tries) {
      const res = await api("put", "/form-layouts/employee_profile/draft").send({ layout });
      expect([name, res.status]).toEqual([name, 400]);
      expect(JSON.stringify(res.body)).toContain(expected);
    }
    expect((await api("post", "/form-layouts/employee_profile/publish")).status).toBe(400); // no draft
    expect((await api("get", "/form-layouts/employee_profile")).body.layout).toEqual(live);
  });

  it("history keeps every publish, an old version can be loaded as a draft, and reset puts the form back to its default", async () => {
    const hist = (await api("get", "/form-layouts/employee_profile/history")).body;
    expect(hist[0]).toMatchObject({ action: "publish", version: 1 });
    const loaded = await api("post", `/form-layouts/employee_profile/history/${hist[0].id}/load`);
    expect([loaded.status, loaded.body.hasDraft]).toEqual([200, true]);
    expect((await api("delete", "/form-layouts/employee_profile/draft")).body.hasDraft).toBe(false);

    const reset = await api("delete", "/form-layouts/employee_profile");
    expect([reset.status, reset.body.livePublished]).toEqual([200, false]);
    expect((await api("get", "/form-layouts/employee_profile", ess)).body.layout).toBeNull();
    // with no layout, the old rules are gone: a read-only CNIC is editable again, contract needs no badge
    expect((await api("patch", `/employees/${employeeId}`).send({ cnic: "35202-1234567-1" })).status).toBe(200);
    const h2 = (await api("get", "/form-layouts/employee_profile/history")).body;
    expect(h2.map((x: { action: string }) => x.action)).toEqual(["reset", "publish"]);
  });
  it("a form whose layout cannot be designed yet refuses a draft with a clear 400", async () => {
    const res = await api("put", "/form-layouts/leave_request/draft").send({ layout: { sections: [{ key: "main", title: "Main", fields: [{ key: "reason" }] }] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot be designed yet/);
  });
});
