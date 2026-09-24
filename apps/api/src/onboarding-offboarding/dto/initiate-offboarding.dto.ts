import { IsDateString, IsIn, IsOptional, IsString } from "class-validator";
import type { OffboardingReason } from "@aihxm/shared-types";

const REASONS: OffboardingReason[] = ["resignation", "termination", "retirement", "end_of_contract", "other"];

export class InitiateOffboardingDto {
  @IsIn(REASONS)
  reason!: OffboardingReason;

  @IsDateString()
  lastWorkingDay!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
