import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs/operators";
import { Observable } from "rxjs";
import { DatabaseService } from "../database/database.service";
import { incrementDailyUsage } from "./usage-tracking.util";
import type { AuthedRequest } from "../auth/platform-admin.guard";

/**
 * TM-027 Usage dashboard's `api_request_count`. Registered globally
 * (app.module.ts, APP_INTERCEPTOR) so it sees every request, but only
 * counts ones that resolved to a real tenant session (`req.claims.
 * company_id` set by SessionGuard/PlatformAdminGuard, which run before
 * interceptors in Nest's pipeline) — a Platform Admin request has no
 * `company_id` and isn't counted against any tenant's usage.
 *
 * The increment itself is fire-and-forget: usage counting is a dashboard
 * metric, not a request-path dependency, so a slow or failing counter
 * write must never add latency to (or fail) the request it's counting.
 */
@Injectable()
export class UsageTrackingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UsageTrackingInterceptor.name);

  constructor(private readonly db: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return next.handle().pipe(
      tap(() => {
        const companyId = req.claims?.company_id;
        if (!companyId) return;
        incrementDailyUsage(this.db, companyId, "api_request_count").catch((err) => {
          this.logger.warn(`Failed to record API usage for company ${companyId}: ${(err as Error).message}`);
        });
      })
    );
  }
}
