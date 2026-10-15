import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { scrubStaleHireDrafts } from "./draft-sensitive-data";
import { HiringProcessService } from "./hiring-process.service";

const CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "hire-draft-hygiene" };

/**
 * Gap Register SEC-04 -- drafts nobody finished must not hold CNIC / bank /
 * salary answers forever. Daily, idempotent: scrubs sensitive values from
 * hire drafts untouched for HIRE_DRAFT_RETENTION_DAYS (default 30). The
 * retention period is a business decision still open in the register's
 * Part D; the default is a conservative placeholder, overridable by env.
 */
@Injectable()
export class HireDraftHygieneScheduler {
  private readonly logger = new Logger(HireDraftHygieneScheduler.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly hiring?: HiringProcessService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<number> {
    // CFG-09: drafts past their expires_at are cancelled (scrubbed, number voided) first.
    const expired = (await this.hiring?.expireStaleDrafts()) ?? 0;
    if (expired > 0) this.logger.log(`Expired ${expired} stale hire draft(s)`);
    const days = Number(process.env.HIRE_DRAFT_RETENTION_DAYS ?? 30);
    const n = await this.db.withClaims(CLAIMS, (client) => scrubStaleHireDrafts(client, Number.isFinite(days) && days > 0 ? days : 30));
    if (n > 0) this.logger.log(`Scrubbed sensitive answers from ${n} stale hire draft(s)`);
    return n;
  }
}
