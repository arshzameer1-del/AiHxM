import { Injectable, NotFoundException } from "@nestjs/common";
import type { MyPersonalDataView, PersonVersionView, PersonView } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { sensitive } from "../crypto/sensitive-fields";

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * The caller's OWN person record (names, birth place, nationality, marital status, passport, NTN) and its dated
 * history, for the "My Personal Data" screen. The caller needs `employee.view.self` (every Employee and Line Manager
 * has it) and there is no way to ask about anyone else: the employee is found from the login. CNIC and date of birth
 * are not returned here - they remain on the employee record, where field rules can hide them.
 */
@Injectable()
export class MyPersonalDataService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService
  ) {}

  async get(claims: RequestClaims): Promise<MyPersonalDataView> {
    if (!claims.company_id) throw new NotFoundException();
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, "employee.view.self", { ownerId: claims.sub }))) throw new NotFoundException();
    const companyId = claims.company_id;

    return this.db.withClaims(claims, async (client) => {
      const me = await client.query(
        "SELECT id, person_id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'terminated'), created_at DESC LIMIT 1",
        [claims.sub]
      );
      if (me.rowCount === 0) throw new NotFoundException("Your login is not linked to an employee record yet.");
      const { id: employeeId, person_id: personId } = me.rows[0] as { id: string; person_id: string | null };
      if (!personId) return { employeeId, person: null, history: [] };

      const p = await client.query("SELECT * FROM persons WHERE id = $1", [personId]);
      if (p.rowCount === 0) return { employeeId, person: null, history: [] };
      const row = p.rows[0];
      const person: PersonView = {
        id: row.id, companyId: row.company_id, fullName: row.full_name, firstName: row.first_name, middleName: row.middle_name,
        lastName: row.last_name, preferredName: row.preferred_name, title: row.title, gender: row.gender,
        nationality: row.nationality, secondNationality: row.second_nationality, language: row.language,
        maritalStatus: row.marital_status, maritalStatusDate: day(row.marital_status_date), placeOfBirth: row.place_of_birth,
        nationalIdType: row.national_id_type, passportExpiry: day(row.passport_expiry),
        createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
        passportNumber: sensitive.decrypt(companyId, row.passport_number),
        ntn: sensitive.decrypt(companyId, row.ntn),
      };

      const h = await client.query("SELECT * FROM person_versions WHERE person_id = $1 ORDER BY valid_from", [personId]);
      const history: PersonVersionView[] = h.rows.map((v) => ({
        id: v.id, personId: v.person_id, validFrom: day(v.valid_from)!, validTo: day(v.valid_to),
        fullName: v.full_name, firstName: v.first_name, middleName: v.middle_name, lastName: v.last_name,
        preferredName: v.preferred_name, title: v.title, gender: v.gender, nationality: v.nationality,
        secondNationality: v.second_nationality, language: v.language, maritalStatus: v.marital_status,
        maritalStatusDate: day(v.marital_status_date), placeOfBirth: v.place_of_birth, nationalIdType: v.national_id_type,
        passportExpiry: day(v.passport_expiry), recordedAt: iso(v.recorded_at)!,
      }));
      return { employeeId, person, history };
    });
  }
}
