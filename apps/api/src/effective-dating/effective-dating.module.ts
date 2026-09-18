import { Module } from "@nestjs/common";
import { EffectiveDatingEngine } from "./effective-dating.engine";

/**
 * No controller — this engine has no HTTP surface of its own, the same
 * shape `DatabaseService`/`AuditService` already use for shared,
 * cross-module infrastructure that every domain consumes but none of
 * them owns.
 */
@Module({
  providers: [EffectiveDatingEngine],
  exports: [EffectiveDatingEngine],
})
export class EffectiveDatingModule {}
