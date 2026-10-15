import { IsNumber, IsOptional, IsUUID, Min } from "class-validator";

/** One entry in `SetEmployeeCompensationComponentsDto.components`. `amount` is the typed figure of a fixed or
 * threshold component and the rate per unit of a per-unit component; `percentage` / `units` are for percentage and
 * per-unit components (the service says which one a component needs). */
export class SetCompensationComponentAmountDto {
  @IsUUID()
  componentId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  percentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  units?: number;
}
