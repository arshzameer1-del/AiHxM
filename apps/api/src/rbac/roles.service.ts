import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "./rbac.service";
import type { CreateCustomRoleRequest, PermissionView, Role } from "@aihxm/shared-types";

const MANAGE_PERMISSION = "role.manage.all";
const ROLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRole(row: any): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    companyId: row.company_id ?? null,
    isSystem: row.is_system,
    isActive: row.is_active,
  };
}

/**
 * ACC-02 -- the role catalog. Platform ("system") roles are seeded by
 * migrations and are read-only here. A tenant may define its own roles
 * (`company_id` set, `is_system` false): stored under a per-company key
 * prefix so two tenants can pick the same name without colliding or
 * revealing each other's roles, and so a custom role can never shadow a
 * system role key.
 *
 * Privilege-escalation rule: a role editor can only put into a custom role
 * permissions the editor holds themselves. System roles are never edited.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService = new RbacService(db),
    private readonly audit: AuditService = new AuditService()
  ) {}

  /** Platform roles plus (for a tenant caller) that tenant's own custom roles. */
  async list(claims: RequestClaims): Promise<Role[]> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM roles ORDER BY is_system DESC, key ASC");
      return result.rows.map(rowToRole);
    });
  }

  /** The permission matrix: every permission with its object, action and scope. */
  async listPermissions(claims: RequestClaims): Promise<PermissionView[]> {
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT id, key, description, object_key, action, scope FROM permissions ORDER BY object_key NULLS LAST, action, scope, key");
      return r.rows.map((p) => ({ id: p.id, key: p.key, description: p.description ?? null, objectKey: p.object_key, action: p.action, scope: p.scope }));
    });
  }

  async getPermissionKeys(claims: RequestClaims, roleId: string): Promise<string[]> {
    return this.db.withClaims(claims, async (client) => {
      await this.mustVisibleRole(client, roleId);
      const r = await client.query(
        "SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY p.key",
        [roleId]
      );
      return r.rows.map((x) => x.key as string);
    });
  }

  async createCustom(claims: RequestClaims, input: CreateCustomRoleRequest): Promise<Role> {
    await this.requireManage(claims);
    if (!KEY_RE.test(input.key ?? "")) throw new BadRequestException("key must be 2-50 lower-case letters, digits or '_' and start with a letter");
    if (!input.name?.trim()) throw new BadRequestException("name is required");
    const storedKey = `c${claims.company_id!.replace(/-/g, "").slice(0, 8)}_${input.key}`;
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query("SELECT 1 FROM roles WHERE key = $1", [storedKey]);
      if (dup.rowCount) throw new ConflictException(`A custom role "${input.key}" already exists`);
      const inserted = await client.query(
        "INSERT INTO roles (key, name, description, company_id) VALUES ($1,$2,$3,$4) RETURNING *",
        [storedKey, input.name.trim(), input.description ?? null, claims.company_id]
      );
      const role = inserted.rows[0];
      if (input.permissionKeys?.length) await this.replacePermissions(client, claims, role.id, input.permissionKeys);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "rbac.custom_role_created",
        target: role.id,
        metadata: { key: storedKey, permissionCount: input.permissionKeys?.length ?? 0 },
      });
      return rowToRole(role);
    });
  }

  async setPermissions(claims: RequestClaims, roleId: string, permissionKeys: string[]): Promise<string[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustOwnCustomRole(client, claims, roleId);
      await this.replacePermissions(client, claims, roleId, permissionKeys);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "rbac.custom_role_permissions_set",
        target: roleId,
        metadata: { permissionKeys },
      });
      return [...new Set(permissionKeys)].sort();
    });
  }

  async setActive(claims: RequestClaims, roleId: string, isActive: boolean): Promise<Role> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustOwnCustomRole(client, claims, roleId);
      const r = await client.query("UPDATE roles SET is_active = $2 WHERE id = $1 RETURNING *", [roleId, isActive]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: isActive ? "rbac.custom_role_activated" : "rbac.custom_role_deactivated",
        target: roleId,
      });
      return rowToRole(r.rows[0]);
    });
  }

  private async replacePermissions(client: PoolClient, claims: RequestClaims, roleId: string, keys: string[]): Promise<void> {
    const unique = [...new Set(keys)];
    const found = unique.length
      ? await client.query<{ id: string; key: string }>("SELECT id, key FROM permissions WHERE key = ANY($1::text[])", [unique])
      : { rows: [] as { id: string; key: string }[] };
    const known = new Set(found.rows.map((p) => p.key));
    const unknown = unique.filter((k) => !known.has(k));
    if (unknown.length) throw new BadRequestException(`Unknown permission(s): ${unknown.join(", ")}`);
    for (const key of unique) {
      if (!(await this.rbac.holdsPermission(claims, key))) {
        throw new ForbiddenException(`You cannot grant "${key}" because you do not hold it yourself`);
      }
    }
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    for (const p of found.rows) {
      await client.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)", [roleId, p.id]);
    }
  }

  private async mustVisibleRole(client: PoolClient, roleId: string) {
    if (!ROLE_UUID_RE.test(roleId)) throw new NotFoundException("Role not found");
    const r = await client.query("SELECT * FROM roles WHERE id = $1", [roleId]);
    if (r.rowCount === 0) throw new NotFoundException("Role not found");
    return r.rows[0];
  }

  private async mustOwnCustomRole(client: PoolClient, claims: RequestClaims, roleId: string) {
    const role = await this.mustVisibleRole(client, roleId);
    if (role.is_system || role.company_id !== claims.company_id) {
      throw new ForbiddenException("Only this company's own custom roles can be changed");
    }
    return role;
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException("Custom roles belong to a company");
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage roles");
  }
}
