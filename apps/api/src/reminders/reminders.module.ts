import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ExpiryRemindersService } from "./expiry-reminders.service";
import { PayrollDeadlineRemindersService } from "./payroll-deadline-reminders.service";

@Module({
  imports: [NotificationsModule],
  providers: [ExpiryRemindersService, PayrollDeadlineRemindersService],
  exports: [ExpiryRemindersService, PayrollDeadlineRemindersService],
})
export class RemindersModule {}
