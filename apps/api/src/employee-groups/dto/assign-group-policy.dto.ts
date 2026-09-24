import { IsIn, IsUUID } from "class-validator";
import type { PolicyType } from "@aihxm/shared-types";

export class AssignGroupPolicyDto {
  @IsIn(["leave"])
  policyType!: PolicyType;

  @IsUUID()
  policyId!: string;
}
