import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { RbacModule } from "../rbac/rbac.module";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";
import { PublicApiController } from "./public-api.controller";

@Module({ imports: [RbacModule, EntitlementsModule, AuditModule], controllers: [ApiKeysController, PublicApiController], providers: [ApiKeysService, ApiKeyGuard], exports: [ApiKeysService] })
export class PublicApiModule {}
