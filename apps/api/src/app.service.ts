import { Injectable } from "@nestjs/common";
import type { HealthStatus } from "@aihxm/shared-types";

@Injectable()
export class AppService {
  getHealth(): HealthStatus {
    return {
      status: "ok",
      service: "ai-hxm-api",
      phase: "Phase 1 — Infrastructure Setup",
      timestamp: new Date().toISOString(),
    };
  }
}
