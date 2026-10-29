import { IsStrongPassword } from "../../auth/password-policy";
import { ArrayUnique, IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { PlatformAdminAccessLevel } from "@aihxm/shared-types";

const ACCESS_LEVELS: PlatformAdminAccessLevel[] = ["full", "read_only", "scoped"];

export class CreatePlatformAdminDto {
  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsStrongPassword()
  initialPassword!: string;

  // Phase 2 gap-fill item #7 — Platform Admin delegation. Omitted = "full",
  // the same unrestricted access every admin had before this existed.
  @IsOptional()
  @IsIn(ACCESS_LEVELS)
  accessLevel?: PlatformAdminAccessLevel;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopedCompanyIds?: string[];
}
