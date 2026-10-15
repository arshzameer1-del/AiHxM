import { IsDateString, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";

export class StartHireProcessDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  hireReasonCode?: string;

  @IsOptional()
  @IsDateString()
  effectiveHireDate?: string;

  @IsOptional()
  @IsDateString()
  plannedEndDate?: string;
}

export class RejectHireProcessDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class TransferHireOwnershipDto {
  @IsUUID()
  ownerUserAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SetHireDelegateDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  delegateUserAccountId!: string | null;
}
