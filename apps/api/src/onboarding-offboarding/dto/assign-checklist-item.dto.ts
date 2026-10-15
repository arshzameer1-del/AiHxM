import { IsDateString, IsOptional, IsUUID, ValidateIf } from "class-validator";

export class AssignChecklistItemDto {
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  assignedToUserAccountId!: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsDateString()
  dueDate?: string | null;
}
