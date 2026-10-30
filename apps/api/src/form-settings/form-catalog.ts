/**
 * The forms whose fields a company may relabel, hide, make required or limit in length, and exactly what may be changed on each.
 * This is the only place that decides it: a field the business always needs (who, which dates, how much) is listed with
 * `canHide: false, canRequire: false`, so it can be renamed and explained but never hidden or made optional.
 * `payloadKey` is the name the field has in the request the form sends.
 */
export type CatalogField = {
  key: string;
  label: string;
  /** Required by the form itself unless a setting says otherwise (only meaningful where canRequire is true). */
  defaultRequired: boolean;
  canHide: boolean;
  canRequire: boolean;
  canSetMaxLength: boolean;
  /** Hard limit the form can never exceed, whatever a setting says. */
  hardMaxLength?: number;
};
export type CatalogForm = { key: string; title: string; fields: CatalogField[] };

const fixed = (key: string, label: string, extra: Partial<CatalogField> = {}): CatalogField => ({
  key,
  label,
  defaultRequired: true,
  canHide: false,
  canRequire: false,
  canSetMaxLength: false,
  ...extra,
});
const optional = (key: string, label: string, extra: Partial<CatalogField> = {}): CatalogField => ({
  key,
  label,
  defaultRequired: false,
  canHide: true,
  canRequire: true,
  canSetMaxLength: true,
  ...extra,
});

export const FORM_CATALOG: CatalogForm[] = [
  {
    key: "leave_request",
    title: "Leave request",
    fields: [
      fixed("leaveType", "Leave type"),
      fixed("startDate", "Start date"),
      fixed("endDate", "End date"),
      optional("reason", "New Note", { hardMaxLength: 2000 }),
      optional("delegateEmployeeId", "Relief person", { canSetMaxLength: false }),
    ],
  },
  {
    key: "expense_claim",
    title: "Expense claim",
    fields: [
      fixed("category", "Category"),
      fixed("expenseDate", "Expense date"),
      fixed("amount", "Amount"),
      optional("description", "Description", { hardMaxLength: 2000 }),
    ],
  },
  {
    key: "helpdesk_ticket",
    title: "HR help desk question",
    fields: [
      fixed("subject", "Title", { canSetMaxLength: true, hardMaxLength: 200 }),
      fixed("body", "Your question", { canSetMaxLength: true, hardMaxLength: 4000 }),
      optional("categoryId", "About", { canSetMaxLength: false }),
    ],
  },
];

export const formByKey = (key: string): CatalogForm | undefined => FORM_CATALOG.find((f) => f.key === key);
