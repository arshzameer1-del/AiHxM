import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [SsoController],
  providers: [SsoService],
  exports: [SsoService],
})
export class SsoModule {}
