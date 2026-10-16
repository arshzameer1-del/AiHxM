import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "./pg-pool.token";
import { queryInTenantContext, runInTenantContext, type RequestClaims } from "./tenant-context";

@Injectable()
export class DatabaseService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Every query a controller/service needs to make against tenant-scoped
   * or platform tables goes through here, wrapped in the caller's claims.
   * There is deliberately no "give me a raw client with no claims"
   * escape hatch on this service — if a future feature genuinely needs
   * one (a background job with no request context, say), it should be a
   * new, explicitly-named method, not a default nobody has to opt into.
   */
  withClaims<T>(claims: RequestClaims, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTenantContext(this.pool, claims, fn);
  }

  /** One read-only query in one round trip (see `queryInTenantContext`): for the small per-request gate lookups. */
  queryWithClaims<R extends Record<string, unknown> = Record<string, unknown>>(
    claims: RequestClaims,
    text: string,
    values: ReadonlyArray<string | number | boolean | null> = []
  ): Promise<{ rows: R[]; rowCount: number }> {
    return queryInTenantContext<R>(this.pool, claims, text, values);
  }

  async close() {
    await this.pool.end();
  }
}
