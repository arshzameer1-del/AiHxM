import { IsIn, IsOptional, IsString } from "class-validator";
import type { ChecklistItemStatus } from "@aihxm/shared-types";

const STATUSES: ChecklistItemStatus[] = ["pending", "completed", "skipped"];

export class UpdateChecklistItemDto {
  @IsIn(STATUSES)
  status!: ChecklistItemStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
