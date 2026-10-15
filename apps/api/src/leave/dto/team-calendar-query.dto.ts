import { IsDateString, IsOptional, IsUUID } from "class-validator";

export class TeamCalendarQueryDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  /** Whose team to show; defaults to the caller's own. */
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
