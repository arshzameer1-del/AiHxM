import { IsUUID } from "class-validator";

export class CreateApplicationDto {
  @IsUUID()
  requisitionId!: string;

  @IsUUID()
  candidateId!: string;
}
