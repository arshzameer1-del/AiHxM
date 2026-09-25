import { IsString, MinLength } from "class-validator";

// Platform Admin's "this admin forgot their password" fix, alongside
// CreateLoginDto's "this admin never had a login" case. Same minimum-length
// rule as CreateLoginDto.initialPassword — a Platform Admin picks the new
// password and hands it to the admin directly, the same hand-off posture
// as creating the login in the first place, not a self-service token flow
// (that already exists for admins who can still receive email — see
// AuthService.requestPasswordReset).
export class ResetAdminPasswordDto {
  @IsString()
  @MinLength(10, { message: "newPassword must be at least 10 characters" })
  newPassword!: string;
}
