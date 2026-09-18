import { Module } from "@nestjs/common";
import { HolidaysController } from "./holidays.controller";
import { HolidaysService } from "./holidays.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule],
  controllers: [HolidaysController],
  providers: [HolidaysService],
  // Exported for future integration work (leave day-count calculation,
  // attendance absence detection) to call directly — same cross-module
  // export pattern ShiftsService already uses for AttendanceService.
  exports: [HolidaysService],
})
export class HolidaysModule {}
