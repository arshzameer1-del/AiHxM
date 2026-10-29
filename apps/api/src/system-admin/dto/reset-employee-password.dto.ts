import { IsStrongPassword } from "../../auth/password-policy";
import { IsString, MaxLength, MinLength } from "class-validator";

/** An admin picks a new temporary password for an employee who already has a login (shared with them directly, shown once). */
export class ResetEmployeePasswordDto {
  @IsString()
  @IsStrongPassword()
  @MaxLength(200)
  newPassword!: string;
}
