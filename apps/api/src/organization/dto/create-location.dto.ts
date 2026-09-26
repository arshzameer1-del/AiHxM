import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import type { LocationType } from "@aihxm/shared-types";

const LOCATION_TYPES: LocationType[] = ["country", "region", "city", "site", "building"];

export class CreateLocationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(LOCATION_TYPES)
  locationType!: LocationType;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export { LOCATION_TYPES };
