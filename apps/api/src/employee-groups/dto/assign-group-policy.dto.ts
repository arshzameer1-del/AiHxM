import { IsIn, IsOptional, IsUUID, Matches } from "class-validator";
import type { PolicyType } from "@aihxm/shared-types";

export const ASSIGNABLE_POLICY_TYPES: PolicyType[] = [
  "leave",
  "probation",
  "confirmation",
  "document",
  "correction",
  "transfer",
  "rehire",
  "termination_exit",
  "retention",
  "required_info",
];

export class AssignGroupPolicyDto {
  @IsIn(ASSIGNABLE_POLICY_TYPES)
  policyType!: PolicyType;

  @IsUUID()
  policyId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveTo?: string;
}
