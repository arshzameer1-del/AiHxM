import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import type { DocumentTemplate, RenderedDocument } from "@aihxm/shared-types";

const MANAGE_PERMISSION = "document_template.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTemplate(row: any): DocumentTemplate {
  return {
    id: row.id,
    companyId: row.company_id,
    key: row.key,
    name: row.name,
    objectKey: row.object_key,
    templateBody: row.template_body,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Plan doc Section 6's "Forms" WRICEF pillar: templated document
 * generation (offer letters, payslips, ID badges — the plan doc's own
 * examples). Deliberately a minimal `{{fieldKey}}` substitution engine,
 * not a full templating language — this is a skeleton phase and nothing
 * yet needs more (plan doc Section 10's guardrail against
 * over-building). A real module can layer its own PDF/HTML rendering on
 * top of the plain-text `render()` output later without this service
 * changing.
 */
@Injectable()
export class DocumentTemplatesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService
  ) {}

  async createTemplate(
    claims: RequestClaims,
    dto: { key: string; name: string; objectKey: string; templateBody: string }
  ): Promise<DocumentTemplate> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage document templates");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO document_templates (company_id, key, name, object_key, template_body)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [claims.company_id, dto.key, dto.name, dto.objectKey, dto.templateBody]
      );
      return toTemplate(result.rows[0]);
    });
  }

  async listTemplates(claims: RequestClaims): Promise<DocumentTemplate[]> {
    if (!claims.company_id) return [];
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM document_templates WHERE company_id = $1 ORDER BY created_at ASC`,
        [claims.company_id]
      );
      return result.rows.map(toTemplate);
    });
  }

  async render(claims: RequestClaims, templateKey: string, record: Record<string, unknown>): Promise<RenderedDocument> {
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query<{ template_body: string }>(
        `SELECT template_body FROM document_templates WHERE company_id = $1 AND key = $2`,
        [claims.company_id, templateKey]
      );
      if (result.rowCount === 0) throw new NotFoundException("No document template with that key");

      const content = result.rows[0].template_body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, fieldKey: string) => {
        const value = record[fieldKey];
        return value === undefined || value === null ? "" : String(value);
      });
      return { templateKey, content };
    });
  }
}
