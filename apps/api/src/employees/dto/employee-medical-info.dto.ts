import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { BloodGroup } from "@aihxm/shared-types";

const GROUPS: BloodGroup[] = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

/** BACKLOG54. A field left out is unchanged; sending null clears it. */
export class UpsertEmployeeMedicalInfoDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @IsIn(GROUPS) bloodGroup?: BloodGroup | null;
  @IsOptional() @IsString() @MaxLength(1000) allergies?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) chronicConditions?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) disabilityNote?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) emergencyMedicalNote?: string | null;
}
