import { Module } from "@nestjs/common";
import { ExpensesController } from "./expenses.controller";
import { ExpenseClaimsService } from "./expense-claims.service";
import { RbacModule } from "../rbac/rbac.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AuditModule } from "../audit/audit.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { FileStorageModule } from "../file-storage/file-storage.module";

@Module({
  imports: [RbacModule, EntitlementsModule, AuditModule, WorkflowModule, FileStorageModule],
  controllers: [ExpensesController],
  providers: [ExpenseClaimsService],
  exports: [ExpenseClaimsService],
})
export class ExpensesModule {}
