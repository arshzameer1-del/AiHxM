import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from "class-validator";
import { RECRUITMENT_SOURCES, type RecruitmentSource } from "@aihxm/shared-types";

export class CreateCandidateDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  nationalId?: string;

  @IsOptional()
  @IsIn([...RECRUITMENT_SOURCES])
  source?: RecruitmentSource;

  @IsOptional()
  @IsString()
  sourceDetail?: string;

  @IsOptional()
  @IsString()
  currentEmployer?: string;

  @IsOptional()
  @IsString()
  currentDesignation?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  expectedSalary?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  noticePeriodDays?: number;

  @IsOptional()
  @IsBoolean()
  consentGiven?: boolean;

  @IsOptional()
  @IsString()
  consentPurpose?: string;

  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}

/** Same fields, all optional; `allowDuplicate` does not apply to edits. */
export class UpdateCandidateDto {
  @IsOptional() @IsString() @MinLength(1) firstName?: string;
  @IsOptional() @IsString() @MinLength(1) lastName?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() nationalId?: string;
  @IsOptional() @IsIn([...RECRUITMENT_SOURCES]) source?: RecruitmentSource;
  @IsOptional() @IsString() sourceDetail?: string;
  @IsOptional() @IsString() currentEmployer?: string;
  @IsOptional() @IsString() currentDesignation?: string;
  @IsOptional() @IsNumber() @Min(0) expectedSalary?: number;
  @IsOptional() @IsInt() @Min(0) noticePeriodDays?: number;
  @IsOptional() @IsBoolean() consentGiven?: boolean;
  @IsOptional() @IsString() consentPurpose?: string;
}

export class CandidateDuplicateCheckDto {
  @IsOptional() @IsString() nationalId?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
}

export class AnonymiseCandidateDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}
