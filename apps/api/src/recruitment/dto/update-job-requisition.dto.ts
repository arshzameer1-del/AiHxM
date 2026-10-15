import { IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";

/** Draft-only edit of a requisition (ORG-01). `null` clears a link. */
export class UpdateJobRequisitionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  headcount?: number;

  @IsOptional()
  @IsString()
  salaryBand?: string;

  @IsOptional()
  @IsString()
  justification?: string;

  @IsOptional()
  @IsUUID()
  hiringManagerId?: string;

  @IsOptional()
  @IsUUID()
  positionId?: string | null;

  @IsOptional()
  @IsUUID()
  orgUnitId?: string | null;

  @IsOptional()
  @IsUUID()
  jobId?: string | null;

  @IsOptional()
  @IsUUID()
  locationId?: string | null;
}

export class RequisitionActionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
