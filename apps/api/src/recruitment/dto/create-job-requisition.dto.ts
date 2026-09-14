import { IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";

export class CreateJobRequisitionDto {
  @IsString()
  @MinLength(1)
  title!: string;

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
}
