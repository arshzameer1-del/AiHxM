import { Module } from "@nestjs/common";
import { PlatformAdminsController } from "./platform-admins.controller";
import { PlatformAdminsService } from "./platform-admins.service";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [AuditModule],
  controllers: [PlatformAdminsController],
  providers: [PlatformAdminsService],
})
export class PlatformAdminsModule {}
