import { ExclusiveCron } from "../common/cron-lock";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RecruitmentPipelineService } from "./recruitment-pipeline.service";
import { RecruitmentService } from "./recruitment.service";

const SYSTEM_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "recruitment-nightly" };

/**
 * Step 11A nightly job, per company: (1) offers past their expiry become `expired` and leave the approval queue;
 * (2) candidates whose retention date has passed and who have nothing in progress are anonymised. A company with no
 * retention months configured has no retention dates, so nothing is anonymised for it. Idempotent; one company's
 * failure is logged and does not stop the others.
 */
@Injectable()
export class RecruitmentScheduler {
  private readonly logger = new Logger(RecruitmentScheduler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly recruitment: RecruitmentService,
    private readonly pipeline: RecruitmentPipelineService
  ) {}

  @Cron("30 2 * * *")
  @ExclusiveCron("RecruitmentScheduler.run")
  async run(onlyCompanyIds?: string[]): Promise<{ expired: number; anonymised: number }> {
    const companyIds = onlyCompanyIds ?? (await this.db.withClaims(SYSTEM_CLAIMS, async (client) =>
      (await client.query<{ id: string }>(`SELECT id FROM companies WHERE status NOT IN ('draft', 'archived') ORDER BY id`)).rows.map((r) => r.id)
    ));
    let expired = 0;
    let anonymised = 0;
    for (const companyId of companyIds) {
      const claims: RequestClaims = { ...SYSTEM_CLAIMS, company_id: companyId };
      try {
        expired += await this.db.withClaims(claims, (client) => this.recruitment.expireOffers(client, claims));
        anonymised += await this.pipeline.anonymiseExpired(claims);
      } catch (err) {
        this.logger.warn(`Recruitment nightly job failed for company ${companyId}: ${(err as Error).message}`);
      }
    }
    if (expired + anonymised > 0) this.logger.log(`Recruitment nightly: ${expired} offer(s) expired, ${anonymised} candidate(s) anonymised`);
    return { expired, anonymised };
  }
}
