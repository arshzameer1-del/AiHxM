import { Module } from "@nestjs/common";
import { MailerModule } from "../mailer/mailer.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { UserNotificationsController } from "./user-notifications.controller";
import { UserNotificationsService } from "./user-notifications.service";

@Module({
  imports: [MailerModule],
  controllers: [NotificationsController, UserNotificationsController],
  providers: [NotificationsService, UserNotificationsService],
  exports: [NotificationsService, UserNotificationsService],
})
export class NotificationsModule {}
