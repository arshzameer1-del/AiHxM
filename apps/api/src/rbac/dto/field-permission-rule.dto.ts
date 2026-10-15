import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import type { FieldAccess, FieldMaskRule } from "@aihxm/shared-types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateFieldPermissionRuleDto {
  @IsUUID() roleId!: string;
  @IsString() @MaxLength(100) objectKey!: string;
  @IsString() @MaxLength(100) fieldKey!: string;
  @IsIn(["view", "edit", "hidden", "masked"]) access!: FieldAccess;
  @IsOptional() @IsIn(["full", "last4", "first1", "email"]) maskRule?: FieldMaskRule;
  @IsOptional() @IsInt() @Min(0) @Max(10000) priority?: number;
  @IsOptional() @IsBoolean() denyOverrides?: boolean;
  @IsOptional() @IsIn(["public", "internal", "confidential", "restricted"]) sensitivityClass?: "public" | "internal" | "confidential" | "restricted";
  @IsOptional() @Matches(DAY) effectiveFrom?: string;
  @IsOptional() @Matches(DAY) effectiveTo?: string;
  @IsOptional() @IsObject() condition?: { field: string; equals: unknown };
}
