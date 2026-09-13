import { IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class CreateDummyRecordDto {
  @IsUUID()
  companyId!: string;

  @IsOptional()
  @IsUUID()
  ownerUserAccountId?: string;

  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsIn(["locked", "unlocked"])
  status?: "locked" | "unlocked";

  @IsOptional()
  @IsString()
  testField?: string;

  @IsOptional()
  @IsString()
  secretField?: string;
}
