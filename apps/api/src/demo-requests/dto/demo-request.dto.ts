import { ArrayMaxSize, Equals, IsArray, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import type { DemoRequestEmployeeCount, DemoRequestStatus } from "@aihxm/shared-types";

export const EMPLOYEE_BANDS: DemoRequestEmployeeCount[] = ["1-50", "51-200", "201-500", "501-1000", "1000+"];
export const DEMO_STATUSES: DemoRequestStatus[] = ["new", "contacted", "qualified", "closed"];
export const DEMO_INTERESTS = [
  "core-hr",
  "payroll",
  "attendance",
  "leave",
  "self-service",
  "approvals",
  "reporting",
  "pakistan-payroll",
  "other",
] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/** Public, unauthenticated body of POST /public/demo-requests. Unknown fields are rejected by the global ValidationPipe. */
export class CreateDemoRequestDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(200)
  workEmail!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  companyName!: string;

  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9+()\-\s]{6,25}$/, { message: "phone must be 6-25 characters: digits, spaces, + ( ) -" })
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  @IsOptional()
  @IsIn(EMPLOYEE_BANDS)
  employeeCount?: DemoRequestEmployeeCount;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsIn(DEMO_INTERESTS, { each: true })
  interests?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  message?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  sourcePage?: string;

  @Equals(true, { message: "You need to accept the privacy notice to send this request" })
  consentPrivacy!: boolean;

  /** Honeypot: hidden from people, filled by bots. Any value here means the request is silently dropped. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}

export class UpdateDemoRequestDto {
  @IsOptional()
  @IsIn(DEMO_STATUSES)
  status?: DemoRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNotes?: string | null;
}
