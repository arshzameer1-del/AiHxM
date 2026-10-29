import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { HealthStatus } from "@aihxm/shared-types";
import { PG_POOL } from "./database/pg-pool.token";

@Injectable()
export class AppService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Liveness: the process is up and answering. Does not touch the database. */
  getHealth(): HealthStatus {
    return {
      status: "ok",
      service: "ai-hxm-api",
      phase: "live",
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: the process can actually serve requests, which needs the database. */
  async getReadiness(): Promise<{ ready: boolean; body: HealthStatus & { database: "up" | "down"; databaseMs: number | null } }> {
    const started = Date.now();
    let database: "up" | "down" = "down";
    let databaseMs: number | null = null;
    try {
      await Promise.race([
        this.pool.query("SELECT 1"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("database check timed out")), 2000)),
      ]);
      database = "up";
      databaseMs = Date.now() - started;
    } catch {
      database = "down";
    }
    return {
      ready: database === "up",
      body: { ...this.getHealth(), status: database === "up" ? "ok" : "degraded", database, databaseMs },
    };
  }
}
