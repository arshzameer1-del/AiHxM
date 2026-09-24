import { IsString, Matches, MinLength } from "class-validator";

export class LoginWithEmployeeNumberDto {
  // Same slug format enforced at company-creation time (CreateCompanyDto) —
  // this is what the subdomain resolves to, never freeform text.
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  companySlug!: string;

  @IsString()
  @MinLength(1)
  employeeNumber!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
