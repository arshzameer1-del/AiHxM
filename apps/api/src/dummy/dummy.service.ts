import { NotFoundException } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import type { DummyRecordView } from "@boostfactor/shared-types";

const OBJECT_KEY = "dummy_record";
const VIEW_PERMISSION = "dummy_record.view";
const SENSITIVE_FIELDS = ["testField", "secretField"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDummy(row: any): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.company_id,
    ownerUserAccountId: row.owner_user_account_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    testField: row.test_field,
    secretField: row.secret_field,
  };
}

/**
 * The proof-of-concept object for Phase 4's engine — see
 * 0004_rbac.sql's header comment. `list`/`get` are the only interesting
 * methods here: they show the real shape every future tenant-object
 * service should follow — RLS narrows to the tenant first, then every row
 * is passed through RbacService.filterRecordFields before it ever reaches
 * a response. `create` exists only so fixtures for manual/automated
 * testing go through the real API rather than a raw SQL insert.
 */
@Injectable()
export class DummyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService
  ) {}

  async list(claims: RequestClaims): Promise<DummyRecordView[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM dummy_records ORDER BY created_at ASC");
      const out: DummyRecordView[] = [];
      for (const row of result.rows) {
        const dummy = rowToDummy(row);
        const filtered = await this.rbac.filterRecordFields(
          claims,
          OBJECT_KEY,
          VIEW_PERMISSION,
          dummy,
          SENSITIVE_FIELDS,
          row.owner_user_account_id
        );
        if (filtered) out.push(filtered as DummyRecordView);
      }
      return out;
    });
  }

  async get(claims: RequestClaims, id: string): Promise<DummyRecordView> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM dummy_records WHERE id = $1", [id]);
      if (result.rowCount === 0) {
        throw new NotFoundException("Dummy record not found");
      }
      const row = result.rows[0];
      const dummy = rowToDummy(row);
      const filtered = await this.rbac.filterRecordFields(
        claims,
        OBJECT_KEY,
        VIEW_PERMISSION,
        dummy,
        SENSITIVE_FIELDS,
        row.owner_user_account_id
      );
      // Same 404 whether the row doesn't exist or RBAC says the caller
      // can't see it at all — existence of a record you can't touch is
      // not information this endpoint should leak either.
      if (!filtered) {
        throw new NotFoundException("Dummy record not found");
      }
      return filtered as DummyRecordView;
    });
  }

  async create(
    claims: RequestClaims,
    input: {
      companyId: string;
      ownerUserAccountId?: string;
      title: string;
      status?: "locked" | "unlocked";
      testField?: string;
      secretField?: string;
    }
  ): Promise<DummyRecordView> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO dummy_records (company_id, owner_user_account_id, title, status, test_field, secret_field)
         VALUES ($1, $2, $3, COALESCE($4, 'locked'), $5, $6)
         RETURNING *`,
        [
          input.companyId,
          input.ownerUserAccountId ?? null,
          input.title,
          input.status ?? null,
          input.testField ?? null,
          input.secretField ?? null,
        ]
      );
      // Created via a Platform Admin session, unfiltered — this is fixture
      // creation, not a real end-user read path.
      return rowToDummy(result.rows[0]) as DummyRecordView;
    });
  }
}
