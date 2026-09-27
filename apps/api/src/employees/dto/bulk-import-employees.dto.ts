import { IsString, MinLength } from "class-validator";

/** `POST /employees/bulk-import` (Core Employee Enterprise Phase 12 —
 * Bulk Hiring). Just the raw CSV text — unlike `DummyService.importCsv()`,
 * no separate `companyId` field: a real tenant caller's own
 * `claims.company_id` already scopes every row this creates, the same way
 * every other real (non-fixture) write in this codebase works. */
export class BulkImportEmployeesDto {
  @IsString()
  @MinLength(1)
  csv!: string;
}
