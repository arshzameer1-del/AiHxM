import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { CompanyStatus, PackageTier } from "@aihxm/shared-types";

const STATUSES: CompanyStatus[] = ["draft", "trial", "active", "suspended", "locked", "archived", "churned"];
const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

export class UpdateCompanyDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: CompanyStatus;

  @IsOptional()
  @IsIn(PACKAGE_TIERS)
  packageTier?: PackageTier;

  // Required by CompaniesService.updateCompany for the two high-risk
  // transitions (TM-005 Suspend, TM-030 Tenant Lock) — optional on the DTO
  // itself so ordinary status/tier edits (e.g. trial -> active) don't need
  // one; the service layer enforces "reason required" only for those two.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
