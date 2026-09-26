import { IsDateString, IsOptional, IsUUID } from "class-validator";

export class AssignPositionDto {
  @IsUUID()
  employeeId!: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
