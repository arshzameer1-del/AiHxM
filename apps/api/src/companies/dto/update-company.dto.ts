import { IsIn, IsOptional } from "class-validator";
import type { CompanyStatus, PackageTier } from "@boostfactor/shared-types";

const STATUSES: CompanyStatus[] = ["trial", "active", "suspended", "churned"];
const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

export class UpdateCompanyDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: CompanyStatus;

  @IsOptional()
  @IsIn(PACKAGE_TIERS)
  packageTier?: PackageTier;
}
