import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ExpiryRemindersService } from "./expiry-reminders.service";

@Module({
  imports: [NotificationsModule],
  providers: [ExpiryRemindersService],
  exports: [ExpiryRemindersService],
})
export class RemindersModule {}
