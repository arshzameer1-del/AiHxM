import { Module } from "@nestjs/common";
import { DummyController } from "./dummy.controller";
import { DummyFixturesController } from "./dummy-fixtures.controller";
import { DummyService } from "./dummy.service";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { ImportExportModule } from "../import-export/import-export.module";

@Module({
  imports: [RbacModule, EntitlementsModule, ImportExportModule],
  controllers: [DummyController, DummyFixturesController],
  providers: [DummyService],
})
export class DummyModule {}
