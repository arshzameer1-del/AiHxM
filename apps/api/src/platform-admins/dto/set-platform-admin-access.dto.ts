import { ArrayUnique, IsArray, IsIn, IsOptional, IsString } from "class-validator";
import type { PlatformAdminAccessLevel } from "@aihxm/shared-types";

const ACCESS_LEVELS: PlatformAdminAccessLevel[] = ["full", "read_only", "scoped"];

/** Phase 2 gap-fill item #7 — changes an existing Platform Admin's
 *  delegation level and (for "scoped") the exact tenant list, in one
 *  request so the two can never briefly disagree. */
export class SetPlatformAdminAccessDto {
  @IsIn(ACCESS_LEVELS)
  accessLevel!: PlatformAdminAccessLevel;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopedCompanyIds?: string[];
}
