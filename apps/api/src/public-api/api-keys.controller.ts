import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from "class-validator";
import type { ApiKeyScope } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ApiKeysService } from "./api-keys.service";

class CreateKeyDto {
  @IsString() @MaxLength(80) name!: string;
  @IsArray() @ArrayMaxSize(5) @IsIn(["employees.read", "org.read"], { each: true }) scopes!: ApiKeyScope[];
}

@Controller("developer/api-keys")
@UseGuards(SessionGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}
  @Get() list(@CurrentClaims() claims: RequestClaims) { return this.keys.list(claims); }
  @Post() @HttpCode(200) create(@CurrentClaims() claims: RequestClaims, @Body() dto: CreateKeyDto) { return this.keys.create(claims, dto.name, dto.scopes); }
  @Delete(":id") revoke(@CurrentClaims() claims: RequestClaims, @Param("id", ParseUUIDPipe) id: string) { return this.keys.revoke(claims, id); }
}
