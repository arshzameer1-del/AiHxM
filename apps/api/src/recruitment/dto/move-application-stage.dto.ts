import { IsIn } from "class-validator";
import type { ApplicationStage } from "@aihxm/shared-types";

export class MoveApplicationStageDto {
  @IsIn(["applied", "screening", "interview", "offer", "hired", "rejected"])
  stage!: ApplicationStage;
}
