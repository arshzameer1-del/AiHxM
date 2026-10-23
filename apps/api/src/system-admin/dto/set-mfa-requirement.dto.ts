import { IsBoolean } from "class-validator";

/** true = the login must enter an authenticator code at sign-in; false = login ID + password only. */
export class SetMfaRequirementDto {
  @IsBoolean()
  required!: boolean;
}
