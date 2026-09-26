import { IsDateString, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { LocationType } from "@aihxm/shared-types";

const LOCATION_TYPES: LocationType[] = ["country", "region", "city", "site", "building"];

/** Renames/retypes/recodes/re-addresses only — reparenting is a distinct
 * endpoint (`MoveLocationDto`) since it's the one edit that needs the
 * cycle guard, not a plain field patch. See LocationsService.move()'s doc
 * comment. */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(LOCATION_TYPES)
  locationType?: LocationType;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
