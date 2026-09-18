import { Module } from "@nestjs/common";
import { RulesEngine } from "./rules-engine.engine";

/**
 * No controller — this engine has no HTTP surface of its own, the same
 * shape `EffectiveDatingModule`/`AuditService` already use for shared,
 * cross-module infrastructure that every domain consumes but none of
 * them owns.
 */
@Module({
  providers: [RulesEngine],
  exports: [RulesEngine],
})
export class RulesEngineModule {}
