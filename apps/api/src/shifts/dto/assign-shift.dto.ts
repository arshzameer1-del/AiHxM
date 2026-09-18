import { IsDateString, IsOptional, IsUUID } from "class-validator";

export class AssignShiftDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  shiftId!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}
