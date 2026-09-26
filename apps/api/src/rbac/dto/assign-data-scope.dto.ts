import { IsIn, IsUUID } from "class-validator";
import type { DataScopeType } from "@aihxm/shared-types";

const SCOPE_TYPES: DataScopeType[] = ["org_unit", "location", "cost_center"];

export class AssignDataScopeDto {
  @IsUUID()
  userAccountId!: string;

  @IsUUID()
  companyId!: string;

  @IsIn(SCOPE_TYPES)
  scopeType!: DataScopeType;

  @IsUUID()
  scopeEntityId!: string;
}
