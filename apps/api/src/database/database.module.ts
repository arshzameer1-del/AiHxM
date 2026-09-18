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
        return new Pool({ connectionString, ssl: resolveSslConfig(connectionString) });
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
