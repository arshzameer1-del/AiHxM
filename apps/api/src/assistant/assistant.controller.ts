import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsString, MaxLength } from "class-validator";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { AssistantService } from "./assistant.service";

class AskDto {
  @IsString() @MaxLength(300) question!: string;
}

@Controller("assistant")
@UseGuards(SessionGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}
  @Post("ask") @HttpCode(200) @Throttle({ default: { limit: 30, ttl: 60_000 } }) ask(@CurrentClaims() claims: RequestClaims, @Body() dto: AskDto) { return this.assistant.ask(claims, dto.question); }
}
