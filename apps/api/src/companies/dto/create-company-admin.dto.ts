import { IsEmail, IsString } from "class-validator";

export class CreateCompanyAdminDto {
  @IsString()
  fullName!: string;

  @IsEmail()
  email!: string;
}
