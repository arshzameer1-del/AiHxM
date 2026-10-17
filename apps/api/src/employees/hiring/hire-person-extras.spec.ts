import { Pool } from "pg";
import { BadRequestException } from "@nestjs/common";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { fieldCrypto } from "../../crypto/field-crypto";
import { sensitive } from "../../crypto/sensitive-fields";
import { applyPersonExtras } from "./hire-person-extras";
import { CARD_FIELD_CATALOG } from "./card-field-catalog";

const FIXTURE: RequestClaims = { is_platform_admin: true, company_id: null, sub: "hire-person-extras-spec" };

/** Real Postgres. The extra Personal Identity answers of a hire land on the person record; blanks never overwrite. */
describe("applyPersonExtras", () => {
  let pool: Pool;
  let db: DatabaseService;
  let companyId: string;
  let personId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await db.withClaims(FIXTURE, async (c) => {
      companyId = (await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Extras ${stamp}`, `extras-${stamp}`])).rows[0].id;
      const emp = await c.query(
        `INSERT INTO employees (company_id, employee_number, first_name, last_name) VALUES ($1,$2,'Sara','Ahmed') RETURNING id, person_id`,
        [companyId, `EX-${stamp.slice(-5)}`]
      );
      personId = emp.rows[0].person_id;
      await c.query("UPDATE persons SET nationality = 'Pakistani' WHERE id = $1", [personId]);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("is listed in the field catalog so HR can switch each new field on or off", () => {
    const keys = CARD_FIELD_CATALOG.filter((f) => f.cardKey === "personal_identity").map((f) => f.fieldKey);
    for (const k of ["middleName", "preferredName", "title", "placeOfBirth", "nationality", "language", "passportNumber", "passportExpiry", "ntn"]) {
      expect(keys).toContain(k);
    }
  });

  it("writes the answers onto the person, encrypting passport and NTN, and keeps what blanks would have wiped", async () => {
    await db.withClaims(FIXTURE, async (c) => {
      await fieldCrypto.warm(c, companyId); // a real hire runs under company claims, which warm the tenant keys already
      const changed = await applyPersonExtras(c, companyId, personId, {
        middleName: " Bibi ",
        preferredName: "Sari",
        title: "Ms",
        placeOfBirth: "Karachi",
        nationality: "",
        language: "Urdu",
        passportNumber: "AB1234567",
        passportExpiry: "2031-05-20",
        ntn: "1234567-8",
      });
      expect(changed).toBe(true);
      const row = (await c.query("SELECT * FROM persons WHERE id = $1", [personId])).rows[0];
      expect(row.middle_name).toBe("Bibi");
      expect(row.preferred_name).toBe("Sari");
      expect(row.title).toBe("Ms");
      expect(row.place_of_birth).toBe("Karachi");
      expect(row.language).toBe("Urdu");
      expect(row.nationality).toBe("Pakistani"); // blank answer did not wipe it
      expect(String(row.passport_expiry).length).toBeGreaterThan(0);
      expect(row.passport_number).not.toBe("AB1234567");
      expect(sensitive.decrypt(companyId, row.passport_number)).toBe("AB1234567");
      expect(sensitive.decrypt(companyId, row.ntn)).toBe("1234567-8");
    });
  });

  it("does nothing for an empty card and rejects a bad passport date", async () => {
    await db.withClaims(FIXTURE, async (c) => {
      expect(await applyPersonExtras(c, companyId, personId, { firstName: "Sara" })).toBe(false);
      await expect(applyPersonExtras(c, companyId, personId, { passportExpiry: "20/05/2031" })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
