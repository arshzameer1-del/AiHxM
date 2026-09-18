import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service";

/**
 * Global so entitlements, RBAC, and any future hot-path service can
 * inject CacheService without each feature module re-declaring it —
 * same rationale as DatabaseModule.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
