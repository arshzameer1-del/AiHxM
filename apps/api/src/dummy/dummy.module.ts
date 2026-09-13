import { Module } from "@nestjs/common";
import { DummyController } from "./dummy.controller";
import { DummyFixturesController } from "./dummy-fixtures.controller";
import { DummyService } from "./dummy.service";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";

@Module({
  imports: [RbacModule, EntitlementsModule],
  controllers: [DummyController, DummyFixturesController],
  providers: [DummyService],
})
export class DummyModule {}
