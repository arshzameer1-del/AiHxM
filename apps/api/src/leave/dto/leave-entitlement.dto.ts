import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min } from "class-validator";
import type { AccrualMethod } from "@aihxm/shared-types";

/** One per-leave-type entitlement of a leave policy version (TLM-01). */
export class LeaveEntitlementDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  leaveType!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  days!: number;

  @IsOptional()
  @IsIn(["upfront", "monthly", "none"])
  accrualMethod?: AccrualMethod | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  carryForwardCapDays?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  expiresAfterMonths?: number | null;
}
