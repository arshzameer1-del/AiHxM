import { Type } from "class-transformer";
import { ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";
import type { DisbursementFieldKey } from "@aihxm/shared-types";
import { DISBURSEMENT_FIELD_KEYS } from "./update-payroll-disbursement-settings.dto";

const DELIMITERS = ["comma", "semicolon", "pipe", "tab"] as const;

/** Create / update of a tenant's bank file layout (PAY-16). The service re-validates (columns vs header labels). */
export class UpsertBankFileFormatDto {
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) code?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(DELIMITERS as unknown as string[]) delimiter?: (typeof DELIMITERS)[number];
  @IsOptional() @IsBoolean() includeHeader?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(DISBURSEMENT_FIELD_KEYS, { each: true }) columns?: DisbursementFieldKey[];
  @IsOptional() @IsObject() headerLabels?: Record<string, string>;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]{2,5}$/) fileExtension?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AcknowledgeItemDto {
  @IsUUID() itemId!: string;
  @IsIn(["acknowledged", "rejected"]) status!: "acknowledged" | "rejected";
  @IsOptional() @IsString() @MaxLength(120) bankReference?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AcknowledgePaymentBatchDto {
  @IsOptional() @IsString() @MaxLength(120) bankReference?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AcknowledgeItemDto) items?: AcknowledgeItemDto[];
}

export class ReissuePaymentItemsDto {
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) itemIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

const RECON_KINDS = ["calculation", "payroll", "payment", "bank", "accounting", "costing", "tax", "reversal"];

export class RunPayrollReconciliationDto {
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(RECON_KINDS, { each: true }) kinds?: string[];
}

export class ResolvePayrollReconciliationDto {
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}
