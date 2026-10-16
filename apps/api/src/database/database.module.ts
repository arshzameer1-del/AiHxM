import { Global, Module, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { DatabaseService } from "./database.service";
import { PG_POOL } from "./pg-pool.token";
import { resolveSslConfig } from "./db-connection.util";

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
        return new Pool({
          connectionString,
          ssl: resolveSslConfig(connectionString),
          idleTimeoutMillis: 300_000,
          keepAlive: true,
          ...(Number.isInteger(max) && max > 0 ? { max } : {}),
        });
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(private readonly db: DatabaseService) {}

  async onModuleDestroy() {
    await this.db.close();
  }
}
