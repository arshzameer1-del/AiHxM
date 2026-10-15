import { Pool } from "pg";

/**
 * Gap Register CAT-02 / CAT-03 / CAT-04 -- migration 0125. Runs as the table
 * owner so the triggers and foreign keys themselves are what is asserted.
 */
describe("catalog backbone (0125)", () => {
  let owner: Pool;
  let company: string;
  let employee: string;
  const item: Record<string, string> = {};

  const mkItem = async (type: string, code: string, label: string, active = true) =>
    (
      await owner.query(
        "INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [company, type, code, label, active]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.DATABASE_URL });
    const stamp = Date.now();
    company = (await owner.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Catbb ${stamp}`, `catbb-${stamp}`])).rows[0].id;
    item.permanent = await mkItem("employment_type", "permanent", "Permanent");
    item.gender_f = await mkItem("gender", "female", "Female");
    item.married = await mkItem("marital_status", "married", "Married");
    item.band = await mkItem("salary_band", "B2", "Band Two");
    item.dupA = await mkItem("asset_type", "lap_a", "Laptop");
    item.dupB = await mkItem("asset_type", "lap_b", "laptop"); // same label, different code -> ambiguous
    item.promo = await mkItem("lifecycle_reason:promotion", "merit", "Merit-based");
    item.compChange = await mkItem("lifecycle_reason:compensation_change", "annual", "Annual increment");
    item.term = await mkItem("lifecycle_reason:termination", "resignation", "Resignation");
    item.addr = await mkItem("address_type", "permanent", "Permanent");
    employee = (
      await owner.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name, employment_type, gender, marital_status, salary_band)
         VALUES ($1,'CB-1','Cat','Backbone','permanent','Female','married','Band Two') RETURNING id`,
        [company]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await owner.query("DELETE FROM companies WHERE id = $1", [company]);
    await owner.end();
  });

  const empRow = async () => (await owner.query("SELECT * FROM employees WHERE id = $1", [employee])).rows[0];

  it("fills the catalog ids from the text on insert: exact code, or a unique case-insensitive label", async () => {
    const e = await empRow();
    expect(e.employment_type_catalog_item_id).toBe(item.permanent);
    expect(e.gender_catalog_item_id).toBe(item.gender_f); // 'Female' matched by label
    expect(e.marital_status_catalog_item_id).toBe(item.married);
    expect(e.salary_band_catalog_item_id).toBe(item.band); // 'Band Two' matched by label
    // the text is preserved untouched
    expect(e.employment_type).toBe("permanent");
    expect(e.gender).toBe("Female");
  });

  it("leaves the id NULL when the match is ambiguous or absent -- nothing is invented", async () => {
    const a = await owner.query(
      "INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag) VALUES ($1,$2,'LAPTOP','L1') RETURNING asset_type_catalog_item_id AS id",
      [company, employee]
    );
    expect(a.rows[0].id).toBeNull();
    const b = await owner.query(
      "INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag) VALUES ($1,$2,'hoverboard','L2') RETURNING asset_type_catalog_item_id AS id",
      [company, employee]
    );
    expect(b.rows[0].id).toBeNull();
    const c = await owner.query(
      "INSERT INTO employee_assets (company_id, employee_id, asset_type, asset_tag) VALUES ($1,$2,'lap_a','L3') RETURNING asset_type_catalog_item_id AS id",
      [company, employee]
    );
    expect(c.rows[0].id).toBe(item.dupA);
  });

  it("re-resolves when the text changes and clears the id when the text is cleared", async () => {
    await owner.query("UPDATE employees SET marital_status = 'unknown-status' WHERE id = $1", [employee]);
    expect((await empRow()).marital_status_catalog_item_id).toBeNull();
    await owner.query("UPDATE employees SET marital_status = 'married' WHERE id = $1", [employee]);
    expect((await empRow()).marital_status_catalog_item_id).toBe(item.married);
    await owner.query("UPDATE employees SET marital_status = NULL WHERE id = $1", [employee]);
    expect((await empRow()).marital_status_catalog_item_id).toBeNull();
  });

  it("respects an explicitly supplied id", async () => {
    await owner.query("UPDATE employees SET employment_type_catalog_item_id = $2 WHERE id = $1", [employee, item.compChange]);
    expect((await empRow()).employment_type_catalog_item_id).toBe(item.compChange);
    await owner.query("UPDATE employees SET employment_type_catalog_item_id = $2 WHERE id = $1", [employee, item.permanent]);
  });

  it("links termination_reason to the lifecycle_reason:termination catalog", async () => {
    await owner.query("UPDATE employees SET termination_reason = 'resignation' WHERE id = $1", [employee]);
    expect((await empRow()).termination_reason_catalog_item_id).toBe(item.term);
    await owner.query("UPDATE employees SET termination_reason = NULL WHERE id = $1", [employee]);
  });

  it("job history picks the reason catalog from the event type (CAT-03), incl. salary_change -> compensation_change", async () => {
    const promo = await owner.query(
      "INSERT INTO employee_job_history (company_id, employee_id, event_type, effective_date, reason_code) VALUES ($1,$2,'promotion', CURRENT_DATE, 'merit') RETURNING reason_catalog_item_id AS id",
      [company, employee]
    );
    expect(promo.rows[0].id).toBe(item.promo);
    const comp = await owner.query(
      "INSERT INTO employee_job_history (company_id, employee_id, event_type, effective_date, reason_code) VALUES ($1,$2,'salary_change', CURRENT_DATE - 1, 'annual') RETURNING reason_catalog_item_id AS id",
      [company, employee]
    );
    expect(comp.rows[0].id).toBe(item.compChange);
    const other = await owner.query(
      "INSERT INTO employee_job_history (company_id, employee_id, event_type, effective_date, reason_code) VALUES ($1,$2,'other', CURRENT_DATE - 2, 'merit') RETURNING reason_catalog_item_id AS id",
      [company, employee]
    );
    expect(other.rows[0].id).toBeNull();
  });

  it("address types link too (CAT-04)", async () => {
    const r = await owner.query(
      "INSERT INTO employee_addresses (company_id, employee_id, address_type, line1, city) VALUES ($1,$2,'permanent','1 Road','Lahore') RETURNING address_type_catalog_item_id AS id",
      [company, employee]
    );
    expect(r.rows[0].id).toBe(item.addr);
  });

  it("a referenced item cannot be hard-deleted, and usage is counted", async () => {
    const usage = await owner.query("SELECT app.catalog_item_usage($1)::int AS n", [item.permanent]);
    expect(usage.rows[0].n).toBeGreaterThanOrEqual(1);
    await expect(owner.query("DELETE FROM hr_reference_catalog_items WHERE id = $1", [item.permanent])).rejects.toThrow(/foreign key/);
    const unused = await mkItem("salary_band", "UNUSED", "Unused");
    expect((await owner.query("SELECT app.catalog_item_usage($1)::int AS n", [unused])).rows[0].n).toBe(0);
    await owner.query("DELETE FROM hr_reference_catalog_items WHERE id = $1", [unused]);
  });

  it("deleting the whole company still works (references are NO ACTION, not RESTRICT)", async () => {
    const stamp = Date.now() + 1;
    const c2 = (await owner.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Catbb2 ${stamp}`, `catbb2-${stamp}`])).rows[0].id;
    await owner.query("INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label) VALUES ($1,'employment_type','permanent','Permanent')", [c2]);
    await owner.query("INSERT INTO employees (company_id, employee_number, first_name, last_name, employment_type) VALUES ($1,'X-1','A','B','permanent')", [c2]);
    await expect(owner.query("DELETE FROM companies WHERE id = $1", [c2])).resolves.toBeDefined();
  });
});
