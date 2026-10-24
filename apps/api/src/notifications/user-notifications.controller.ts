import { Body, Controller, Get, Post, Put, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CATEGORY_KEYS } from "./notification-categories";
import { UserNotificationsService } from "./user-notifications.service";

class MarkReadDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  ids?: string[];
}

class PreferenceItemDto {
  @IsString()
  @IsIn(CATEGORY_KEYS)
  category!: string;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  inApp?: boolean;
}

class SavePreferencesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  preferences!: PreferenceItemDto[];
}

/** BACKLOG51 - the signed-in person's own notifications (the bell) and notification preferences. */
@Controller("notifications")
@UseGuards(SessionGuard)
export class UserNotificationsController {
  constructor(private readonly notifications: UserNotificationsService) {}

  @Get("inbox")
  inbox(@CurrentClaims() claims: RequestClaims) {
    return this.notifications.inbox(claims);
  }

  @Post("inbox/read")
  markRead(@CurrentClaims() claims: RequestClaims, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(claims, dto.ids);
  }

  @Get("preferences")
  preferences(@CurrentClaims() claims: RequestClaims) {
    return this.notifications.getPreferences(claims);
  }

  @Put("preferences")
  savePreferences(@CurrentClaims() claims: RequestClaims, @Body() dto: SavePreferencesDto) {
    return this.notifications.savePreferences(claims, dto.preferences);
  }
}
