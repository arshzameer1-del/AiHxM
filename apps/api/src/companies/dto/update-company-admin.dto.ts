import { IsIn } from "class-validator";
import type { CompanyAdminStatus } from "@boostfactor/shared-types";

const STATUSES: CompanyAdminStatus[] = ["active", "locked"];

export class UpdateCompanyAdminDto {
  @IsIn(STATUSES)
  status!: CompanyAdminStatus;
}
