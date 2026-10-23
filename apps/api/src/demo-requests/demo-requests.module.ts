import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { MailerModule } from "../mailer/mailer.module";
import { DemoRequestsService } from "./demo-requests.service";
import { PlatformDemoRequestsController, PublicDemoRequestsController } from "./demo-requests.controller";

@Module({
  imports: [AuditModule, MailerModule],
  controllers: [PublicDemoRequestsController, PlatformDemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
