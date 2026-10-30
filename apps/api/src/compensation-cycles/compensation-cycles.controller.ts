import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CompensationCyclesService } from "./compensation-cycles.service";

class CycleDto {
  @IsString() @MaxLength(120) name!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveFrom!: string;
  @IsOptional() @IsNumber() budgetAmount?: number | null;
}
class ItemDto {
  @IsUUID() employeeId!: string;
  @IsNumber() proposedBasic!: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string | null;
}
class ItemsDto {
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}
class ApproveDto {
  @IsOptional() @IsBoolean() samePersonConfirmed?: boolean;
}

@Controller("compensation-cycles")
@UseGuards(SessionGuard)
export class CompensationCyclesController {
  constructor(private readonly cycles: CompensationCyclesService) {}
  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.cycles.list(claims); }
  @Post() @HttpCode(200) create(@CurrentClaims() claims: RequestClaims, @Body() dto: CycleDto) { return this.cycles.create(claims, dto); }
  @Post(":id/load-people") @HttpCode(200) load(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.cycles.loadPeople(claims, id); }
  @Put(":id/items") saveItems(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ItemsDto) { return this.cycles.saveItems(claims, id, dto); }
  @Post(":id/submit") @HttpCode(200) submit(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.cycles.submit(claims, id); }
  @Post(":id/withdraw") @HttpCode(200) withdraw(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.cycles.withdraw(claims, id); }
  @Post(":id/approve") @HttpCode(200) approve(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ApproveDto) { return this.cycles.approve(claims, id, dto.samePersonConfirmed === true); }
  @Post(":id/apply") @HttpCode(200) apply(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.cycles.apply(claims, id); }
  @Post(":id/cancel") @HttpCode(200) cancel(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.cycles.cancel(claims, id); }
}
