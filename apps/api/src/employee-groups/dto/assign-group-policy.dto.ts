import { IsIn, IsUUID } from "class-validator";
import type { PolicyType } from "@boostfactor/shared-types";

export class AssignGroupPolicyDto {
  @IsIn(["leave"])
  policyType!: PolicyType;

  @IsUUID()
  policyId!: string;
}
