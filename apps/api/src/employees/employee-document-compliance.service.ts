import { localToday } from "../common/local-date";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  EmployeeDocumentChecklist,
  EmployeeDocumentChecklistItem,
  EmployeeDocumentView,
  PendingEmployeeDocumentView,
  RequiredEmployeeDocumentTypes,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { HrReferenceCatalogService } from "../hr-administration/hr-reference-catalog.service";
import { HrBusinessPolicyService } from "../hr-administration/hr-business-policy.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";
import { EmployeesService, rowToDocument } from "./employees.service";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const VIEW_PERMISSION = "employee.view";
const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"];

/**
 * BACKLOG50 - the HR side of the document vault: the inbox of documents employees uploaded, the company's mandatory
 * document types, the per-employee checklist (on file / waiting for HR / missing / expired) and the profile photo.
 */
@Injectable()
export class EmployeeDocumentComplianceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly hrCatalog?: HrReferenceCatalogService,
    private readonly businessPolicy?: HrBusinessPolicyService,
    private readonly inbox?: UserNotificationsService
  ) {}

  // ---- review inbox ---------------------------------------------------------------------------------------------

  async listPending(claims: RequestClaims): Promise<PendingEmployeeDocumentView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT d.*, e.employee_number, trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')) AS employee_name
           FROM employee_documents d JOIN employees e ON e.id = d.employee_id
          WHERE d.review_status = 'pending'
          ORDER BY d.created_at ASC`
      );
      return r.rows.map((row) => ({ ...rowToDocument(row), employeeNumber: row.employee_number, employeeName: row.employee_name }));
    });
  }

  async review(claims: RequestClaims, documentId: string, decision: "approved" | "rejected", note?: string | null): Promise<EmployeeDocumentView> {
    await this.requireManage(claims);
    const reviewNote = note ? String(note).trim().slice(0, 1000) || null : null;
    if (decision === "rejected" && !reviewNote) throw new BadRequestException("Tell the employee why the document was rejected");
    const reviewed = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `UPDATE employee_documents
            SET review_status = $2, review_note = $3, reviewed_at = now(), reviewed_by_user_account_id = $4
          WHERE id = $1 AND review_status = 'pending'
          RETURNING *`,
        [documentId, decision, reviewNote, claims.sub]
      );
      if (r.rowCount === 0) {
        const exists = await client.query("SELECT review_status FROM employee_documents WHERE id = $1", [documentId]);
        if (exists.rowCount === 0) throw new NotFoundException("Document not found");
        throw new BadRequestException("This document has already been reviewed");
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id!,
        action: decision === "approved" ? "employee_document.approve" : "employee_document.reject",
        target: documentId,
        metadata: { employeeId: r.rows[0].employee_id, documentType: r.rows[0].document_type },
      });
      return rowToDocument(r.rows[0]);
    });
    if (this.inbox && claims.company_id) {
      const owner = await this.db.withClaims(claims, (client) => client.query("SELECT user_account_id FROM employees WHERE id = $1", [reviewed.employeeId]));
      await this.inbox.notify({
        companyId: claims.company_id,
        userAccountIds: [owner.rows[0]?.user_account_id],
        category: "request_decisions",
        title: decision === "approved" ? "HR approved your document" : "HR did not approve your document",
        body: `${reviewed.fileName}${reviewed.reviewNote ? ` - ${reviewed.reviewNote}` : ""}`,
        link: "/app/profile?tab=documents",
      });
    }
    return reviewed;
  }

  /** An employee's own upload (waits for HR) - HR Admins are told there is something to review. */
  async uploadOwn(
    claims: RequestClaims,
    employeeId: string,
    documentType: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    extra: { expiryDate?: string | null; note?: string | null } = {}
  ): Promise<EmployeeDocumentView> {
    if (!file) throw new BadRequestException("Choose a file to upload");
    const doc = await this.employees.addOwnDocument(claims, employeeId, documentType, file, extra);
    if (this.inbox && claims.company_id) {
      const hr = await this.inbox.hrAdminUserIds(claims.company_id);
      await this.inbox.notify({
        companyId: claims.company_id,
        userAccountIds: hr,
        category: "hr_inbox",
        title: "A document is waiting for your review",
        body: `${doc.fileName} (${doc.documentType.replace(/_/g, " ")})`,
        link: "/app/employees/change-requests",
      });
    }
    return doc;
  }

  // ---- mandatory document types -----------------------------------------------------------------------------------
  // The list lives in ONE place: HR Administration > Business Policies > Document Policy (`requiredDocumentTypes`).

  async getRequired(claims: RequestClaims): Promise<RequiredEmployeeDocumentTypes> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => ({ documentTypes: await this.readRequired(client, claims.company_id!, null) }));
  }

  /** Replaces the list on the company's default Document Policy. Every type must be an active `document_type` catalog code. */
  async setRequired(claims: RequestClaims, documentTypes: string[]): Promise<RequiredEmployeeDocumentTypes> {
    await this.requireManage(claims);
    const wanted = Array.from(new Set((documentTypes ?? []).map((t) => String(t).trim()).filter(Boolean))).sort();
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id!;
      for (const t of wanted) await this.hrCatalog?.validateActiveCode(client, companyId, "document_type", t);
      await this.businessPolicy?.resolveDefaultPolicy(client, companyId, "document"); // seeds the standard policy when missing
      const updated = await client.query(
        `UPDATE hr_business_policies
            SET rules = jsonb_set(COALESCE(rules, '{}'::jsonb), '{requiredDocumentTypes}', $2::jsonb, true), updated_at = now()
          WHERE company_id = $1 AND policy_type = 'document' AND is_default = true AND is_active = true`,
        [companyId, JSON.stringify(wanted)]
      );
      if (updated.rowCount === 0) {
        await client.query(
          `INSERT INTO hr_business_policies (company_id, policy_type, code, name, description, rules, is_default, sort_order)
           VALUES ($1, 'document', 'default', 'Standard Document Requirements', 'The documents every employee is expected to have on file.', $2::jsonb, true, 0)
           ON CONFLICT (company_id, policy_type, code) DO UPDATE SET rules = EXCLUDED.rules, is_default = true, is_active = true, updated_at = now()`,
          [companyId, JSON.stringify({ requiredDocumentTypes: wanted })]
        );
      }
      await this.audit.record(client, claims, {
        companyId,
        action: "employee_required_documents.update",
        target: companyId,
        metadata: { documentTypes: wanted },
      });
      return { documentTypes: wanted };
    });
  }

  private async readRequired(client: PoolClient, companyId: string, employeeId: string | null): Promise<string[]> {
    if (!this.businessPolicy) return [];
    const rules = await this.businessPolicy.resolveEffectivePolicy(client, companyId, "document", { employeeId });
    const list = rules?.requiredDocumentTypes;
    return Array.isArray(list) ? Array.from(new Set(list.map(String))).sort() : [];
  }

  // ---- per-employee checklist -------------------------------------------------------------------------------------

  async checklist(claims: RequestClaims, employeeId: string): Promise<EmployeeDocumentChecklist> {
    await this.employees.get(claims, employeeId); // same visibility as the employee record itself (HR, manager scope, or self)
    const canManage = await this.rbac.can(claims, MANAGE_PERMISSION);
    return this.db.withClaims(claims, async (client) => {
      const required = (await this.readRequired(client, claims.company_id!, employeeId)).map((t) => ({ document_type: t }));
      const docs = await client.query(
        `SELECT id, document_type, review_status, expiry_date, uploaded_by_user_account_id, created_at
           FROM employee_documents WHERE employee_id = $1 AND review_status <> 'rejected' ORDER BY created_at DESC`,
        [employeeId]
      );
      const today = localToday();
      const items: EmployeeDocumentChecklistItem[] = required.map((req) => {
        const type = req.document_type as string;
        const mine = docs.rows.filter(
          (d) => d.document_type === type && (canManage || d.review_status === "approved" || d.uploaded_by_user_account_id === claims.sub)
        );
        const approved = mine.filter((d) => d.review_status === "approved");
        const inDate = approved.find((d) => !d.expiry_date || String(d.expiry_date instanceof Date ? d.expiry_date.toISOString() : d.expiry_date).slice(0, 10) >= today);
        const pick = inDate ?? approved[0] ?? mine[0];
        const expiryOf = (d: { expiry_date: unknown } | undefined) =>
          d?.expiry_date ? String(d.expiry_date instanceof Date ? d.expiry_date.toISOString() : d.expiry_date).slice(0, 10) : null;
        let status: EmployeeDocumentChecklistItem["status"];
        if (inDate) status = "on_file";
        else if (mine.some((d) => d.review_status === "pending")) status = "pending";
        else if (approved.length > 0) status = "expired";
        else status = "missing";
        return { documentType: type, status, documentId: pick?.id ?? null, expiryDate: expiryOf(pick) };
      });
      return {
        employeeId,
        items,
        completeCount: items.filter((i) => i.status === "on_file").length,
        requiredCount: items.length,
      };
    });
  }

  // ---- profile photo ----------------------------------------------------------------------------------------------

  /** The latest APPROVED image of type `photograph` for anyone in the company, or null when there is none (BACKLOG59). */
  async photo(claims: RequestClaims, employeeId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    return this.employees.readApprovedPhoto(claims, employeeId, PHOTO_MIMES);
  }

  // ---- guards -----------------------------------------------------------------------------------------------------

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage employee documents");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage, isSelf] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
      this.rbac.can(claims, "employee.view.self", { ownerId: claims.sub }),
    ]);
    if (!canView && !canManage && !isSelf) throw new ForbiddenException("Not permitted to view required documents");
  }
}
