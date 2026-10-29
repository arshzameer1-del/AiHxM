import { Global, Logger, Module, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { DatabaseService } from "./database.service";
import { PG_POOL } from "./pg-pool.token";
import { resolveSslConfig } from "./db-connection.util";
import { registerCronLockPool } from "../common/cron-lock";

/**
 * Global module so every feature module can inject DatabaseService
 * without re-declaring this wiring. Connects as `app_role` — the same
 * role migration 0001 wrote RLS policies for — never as the
 * migration/owner role. If this connection string is ever pointed at a
 * superuser by mistake, RLS silently stops doing anything; there is no
 * code-level guard against that, only discipline about which env var
 * (`APP_DATABASE_URL`) this reads.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const connectionString = process.env.APP_DATABASE_URL;
        if (!connectionString) {
          throw new Error("APP_DATABASE_URL is not set");
        }
        // A new connection to a remote database costs several round trips (TCP, TLS, login), so connections are kept
        // for five minutes when idle (the default 10 seconds closed them between clicks) and kept alive at the TCP level.
        // PG_POOL_MAX raises the ceiling if the database host allows more connections.
        const max = Number(process.env.PG_POOL_MAX);
        const pool = new Pool({
          connectionString,
          ssl: resolveSslConfig(connectionString),
          idleTimeoutMillis: 300_000,
          keepAlive: true,
          // Waiting for a free connection longer than this fails the request instead of hanging it forever.
          connectionTimeoutMillis: 15_000,
          ...(Number.isInteger(max) && max > 0 ? { max } : {}),
        });
        // An idle connection can be dropped by the database at any time (restart, failover, maintenance). pg reports that
        // as an 'error' event on the pool; with no listener Node treats it as fatal and the whole API exits. Log it and let
        // the pool open a fresh connection on the next query instead.
        const logger = new Logger("DatabasePool");
        let lastLogged = 0;
        pool.on("error", (err) => {
          const now = Date.now();
          if (now - lastLogged > 10_000) {
            lastLogged = now;
            logger.error(`Idle database connection error (pool keeps running): ${err.message}`);
          }
        });
        registerCronLockPool(pool);
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService, PG_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(private readonly db: DatabaseService) {}

  async onModuleDestroy() {
    await this.db.close();
  }
}
