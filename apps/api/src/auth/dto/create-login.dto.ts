import { IsOptional, IsString, Matches, MinLength } from "class-validator";

export class CreateLoginDto {
  @IsString()
  @MinLength(10, { message: "initialPassword must be at least 10 characters" })
  initialPassword!: string;

  // Only used by the Company Admin login route (CompaniesService.createAdminLogin)
  // — see CreateLoginRequest.loginId in shared-types for why this exists.
  // Letters/digits/underscore/hyphen/dot only, same "typeable identifier,
  // not freeform text" posture as a company slug, but case is preserved
  // (the DB comparison is case-insensitive — see migration 0048).
  @IsOptional()
  @IsString()
  @MinLength(3, { message: "loginId must be at least 3 characters" })
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: "loginId may only contain letters, digits, underscore, hyphen, and dot",
  })
  loginId?: string;
}
