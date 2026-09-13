import { Module } from "@nestjs/common";
import { DummyController } from "./dummy.controller";
import { DummyFixturesController } from "./dummy-fixtures.controller";
import { DummyService } from "./dummy.service";
import { RbacModule } from "../rbac/rbac.module";

@Module({
  imports: [RbacModule],
  controllers: [DummyController, DummyFixturesController],
  providers: [DummyService],
})
export class DummyModule {}
