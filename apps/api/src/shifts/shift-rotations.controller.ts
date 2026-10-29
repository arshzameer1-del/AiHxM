import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsUUID, Matches, Max, Min, ValidateNested } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ShiftRotationsService } from "./shift-rotations.service";

class RotationWeekDto {
  @IsInt() @Min(1) @Max(12) weekNo!: number;
  @IsUUID() memberShiftId!: string;
}
class SaveRotationDto {
  @IsInt() @Min(2) @Max(12) cycleWeeks!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) anchorDate!: string;
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => RotationWeekDto) weeks!: RotationWeekDto[];
}

@Controller("shifts/:id/rotation")
@UseGuards(SessionGuard)
export class ShiftRotationsController {
  constructor(private readonly rotations: ShiftRotationsService) {}

  @Get()
  get(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.rotations.get(claims, id).then((r) => r ?? null);
  }

  @Put()
  save(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string, @Body() dto: SaveRotationDto) {
    return this.rotations.save(claims, id, dto);
  }

  @Delete()
  @HttpCode(204)
  remove(@CurrentClaims() claims: RequestClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.rotations.remove(claims, id);
  }
}
