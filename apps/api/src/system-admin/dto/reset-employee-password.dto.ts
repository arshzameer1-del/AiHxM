import { IsString, MaxLength, MinLength } from "class-validator";

/** An admin picks a new temporary password for an employee who already has a login (shared with them directly, shown once). */
export class ResetEmployeePasswordDto {
  @IsString()
  @MinLength(8, { message: "newPassword must be at least 8 characters" })
  @MaxLength(200)
  newPassword!: string;
}
