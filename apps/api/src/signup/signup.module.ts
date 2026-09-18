import { Module } from "@nestjs/common";
import { SignupController } from "./signup.controller";
import { SignupService } from "./signup.service";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";

@Module({
  imports: [AuditModule, EntitlementsModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
