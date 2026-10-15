import { IsIn, IsOptional, IsString } from "class-validator";
import type { ApplicationStage } from "@aihxm/shared-types";

export class MoveApplicationStageDto {
  @IsIn(["applied", "screening", "interview", "offer", "hired", "rejected"])
  stage!: ApplicationStage;

  /** Required when rejecting (enforced in the service so the message is specific). */
  @IsOptional()
  @IsString()
  reason?: string;
}
