import { IsDateString, IsNumber, IsUUID, Min } from "class-validator";

export class SetCompensationDto {
  @IsUUID()
  employeeId!: string;

  @IsNumber()
  @Min(0)
  monthlySalary!: number;

  @IsDateString()
  effectiveFrom!: string;
}
