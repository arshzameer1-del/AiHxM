import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from "class-validator";
import { LeaveEntitlementDto } from "../../leave/dto/leave-entitlement.dto";

export class CreateLeavePolicyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  annualLeaveDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  casualLeaveDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sickLeaveDays?: number;

  /** TLM-01: entitlements for any leave type (annual / casual / sick here win over the legacy fields above). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LeaveEntitlementDto)
  entitlements?: LeaveEntitlementDto[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
