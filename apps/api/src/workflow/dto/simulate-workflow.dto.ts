import { IsObject, IsOptional, IsUUID } from "class-validator";

export class SimulateWorkflowDto {
  @IsUUID()
  subjectUserAccountId!: string;

  @IsOptional()
  @IsObject()
  record?: Record<string, unknown>;
}
