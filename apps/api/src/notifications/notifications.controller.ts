import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { NotificationsService } from "./notifications.service";
import { DispatchNotificationDto } from "./dto/dispatch-notification.dto";

@Controller("notifications")
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  dispatch(@CurrentClaims() claims: RequestClaims, @Body() dto: DispatchNotificationDto) {
    return this.notifications.dispatch(claims, dto);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("limit") limit?: string) {
    return this.notifications.list(claims, limit ? Number(limit) : undefined);
  }
}
