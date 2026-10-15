import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { SetCompensationComponentAmountDto } from "./set-compensation-component-amount.dto";

export class SetEmployeeCompensationComponentsDto {
  @IsUUID()
  employeeId!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SetCompensationComponentAmountDto)
  components!: SetCompensationComponentAmountDto[];

  @IsOptional()
  @IsIn(["monthly", "annual"])
  payFrequency?: "monthly" | "annual";

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currencyCode?: string;

  @IsOptional()
  @IsUUID()
  changeReasonCatalogItemId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeReasonNote?: string | null;

  @IsOptional()
  @IsUUID()
  salaryGradeId?: string | null;
}
