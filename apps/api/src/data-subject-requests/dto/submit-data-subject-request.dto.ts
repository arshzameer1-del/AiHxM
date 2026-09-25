import { IsIn, IsString, IsUUID, MinLength } from "class-validator";
import type { DataSubjectRequestType } from "@aihxm/shared-types";

export class SubmitDataSubjectRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(["access", "correction", "deletion"])
  requestType!: DataSubjectRequestType;

  @IsString()
  @MinLength(1)
  description!: string;
}
