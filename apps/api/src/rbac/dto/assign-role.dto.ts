import { IsString, IsUUID, MinLength } from "class-validator";

export class AssignRoleDto {
  @IsUUID()
  userAccountId!: string;

  @IsUUID()
  companyId!: string;

  @IsString()
  @MinLength(1)
  roleKey!: string;
}
