import { IsIn, IsObject, IsOptional, IsString, MinLength } from "class-validator";
import type { NotificationChannel } from "@aihxm/shared-types";

export class DispatchNotificationDto {
  @IsIn(["email", "whatsapp", "push", "in_app"])
  channel!: NotificationChannel;

  @IsString()
  @MinLength(1)
  recipient!: string;

  @IsString()
  @MinLength(1)
  templateKey!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
