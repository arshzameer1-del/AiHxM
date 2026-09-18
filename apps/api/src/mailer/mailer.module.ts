import { Module } from "@nestjs/common";
import { MailerService } from "./mailer.service";

/**
 * No controller — same controller-less shared-infrastructure shape as
 * `EffectiveDatingModule`/`RulesEngineModule`.
 */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
