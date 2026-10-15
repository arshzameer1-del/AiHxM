import { IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import { RECRUITMENT_SOURCES, type RecruitmentSource } from "@aihxm/shared-types";

export class CreateApplicationDto {
  @IsUUID()
  requisitionId!: string;

  @IsUUID()
  candidateId!: string;

  @IsOptional()
  @IsIn([...RECRUITMENT_SOURCES])
  source?: RecruitmentSource;

  @IsOptional()
  @IsString()
  sourceDetail?: string;
}
