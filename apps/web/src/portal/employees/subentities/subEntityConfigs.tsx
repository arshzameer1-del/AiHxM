import { api } from "../../../api/client";
import type {
  EmployeeAddressView,
  EmployeeAssetView,
  EmployeeContactView,
  EmployeeCostAllocationView,
  EmployeeEducationView,
  EmployeeFamilyMemberView,
  EmployeeImportantDateView,
  EmployeePaymentAccountView,
  EmployeeQualificationView,
} from "@aihxm/shared-types";
import type { SubEntityPanelConfig } from "./SubEntityPanel";

/**
 * One config per sub-entity family — see `SubEntityPanel.tsx`'s own
 * header comment for why these are data, not nine separate components.
 * Field lists mirror each DTO exactly (`create-employee-*.dto.ts`/
 * `update-employee-*.dto.ts`), including which fields the Update DTO
 * deliberately omits (e.g. `contactType`/`addressType` can't change after
 * creation — see each type's own `Update = Partial<Omit<Create, ...>>`
 * definition in shared-types).
 */

// HR Administration v2 "then 2" Phase 1 (2026-10-01) — `contactType` moved
// onto this tenant's own `contact_type` catalog
// (EmployeeContactsService.createWithinTransaction()'s own
// validateActiveCode() call); these fallbacks are only what the dropdown
// shows if that catalog fails to load, the same
// `costCenterOptions`-as-a-parameter shape `costAllocationsConfig` below
// already established for a dynamic option list.
const FALLBACK_CONTACT_TYPE_OPTIONS = [
  { value: "business_email", label: "Business email" },
  { value: "personal_email", label: "Personal email" },
  { value: "business_phone", label: "Business phone" },
  { value: "personal_phone", label: "Personal phone" },
  { value: "emergency_contact", label: "Emergency contact" },
];

export function contactsConfig(contactTypeOptions: { value: string; label: string }[]): SubEntityPanelConfig<EmployeeContactView> {
  const options = contactTypeOptions.length > 0 ? contactTypeOptions : FALLBACK_CONTACT_TYPE_OPTIONS;
  return {
    title: "Contact",
    addLabel: "+ Add contact",
    emptyLabel: "No contacts on file.",
    createFields: [
      { key: "contactType", label: "Type", type: "select", required: true, options },
      { key: "value", label: "Value", type: "text", required: true, placeholder: "email or phone number" },
      { key: "label", label: "Label", type: "text", placeholder: "optional" },
      { key: "isPrimary", label: "Primary", type: "checkbox" },
    ],
    updateFields: [
      { key: "value", label: "Value", type: "text", required: true },
      { key: "label", label: "Label", type: "text" },
      { key: "isPrimary", label: "Primary", type: "checkbox" },
    ],
    renderSummary: (item) => ({
      primary: `${options.find((o) => o.value === item.contactType)?.label ?? item.contactType} — ${item.value}${item.isPrimary ? " ★" : ""}`,
      secondary: item.label ?? undefined,
    }),
    openStatus: "active",
    closedStatusLabel: "Ended",
    closeActionLabel: "End",
    closeConfirm: (item) => `End this contact (${item.value})? It will no longer show as active.`,
    list: (employeeId) => api.listEmployeeContacts(employeeId),
    create: (employeeId, values) => api.createEmployeeContact({ employeeId, ...values } as Parameters<typeof api.createEmployeeContact>[0]),
    update: (id, values) => api.updateEmployeeContact(id, values as Parameters<typeof api.updateEmployeeContact>[1]),
    close: (id) => api.endEmployeeContact(id),
  };
}

// Same treatment for `addressType` -> this tenant's own `address_type`
// catalog (EmployeeAddressesService.createWithinTransaction()'s own
// validateActiveCode() call).
const FALLBACK_ADDRESS_TYPE_OPTIONS = [
  { value: "permanent", label: "Permanent" },
  { value: "current", label: "Current" },
  { value: "mailing", label: "Mailing" },
];

export function addressesConfig(addressTypeOptions: { value: string; label: string }[]): SubEntityPanelConfig<EmployeeAddressView> {
  const options = addressTypeOptions.length > 0 ? addressTypeOptions : FALLBACK_ADDRESS_TYPE_OPTIONS;
  return {
    title: "Addresses",
    addLabel: "+ Add address",
    emptyLabel: "No addresses on file.",
    createFields: [
      { key: "addressType", label: "Type", type: "select", required: true, options },
      { key: "line1", label: "Address line 1", type: "text", required: true },
      { key: "line2", label: "Address line 2", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "stateProvince", label: "State / Province", type: "text" },
      { key: "postalCode", label: "Postal code", type: "text" },
      { key: "country", label: "Country", type: "text" },
    ],
    updateFields: [
      { key: "line1", label: "Address line 1", type: "text", required: true },
      { key: "line2", label: "Address line 2", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "stateProvince", label: "State / Province", type: "text" },
      { key: "postalCode", label: "Postal code", type: "text" },
      { key: "country", label: "Country", type: "text" },
    ],
    renderSummary: (item) => ({
      primary: `${options.find((o) => o.value === item.addressType)?.label ?? item.addressType} — ${item.line1}`,
      secondary: [item.city, item.stateProvince, item.country].filter(Boolean).join(", ") || undefined,
    }),
    openStatus: "active",
    closedStatusLabel: "Ended",
    closeActionLabel: "End",
    closeConfirm: () => "End this address? It will no longer show as active.",
    list: (employeeId) => api.listEmployeeAddresses(employeeId),
    create: (employeeId, values) => api.createEmployeeAddress({ employeeId, ...values } as Parameters<typeof api.createEmployeeAddress>[0]),
    update: (id, values) => api.updateEmployeeAddress(id, values as Parameters<typeof api.updateEmployeeAddress>[1]),
    close: (id) => api.endEmployeeAddress(id),
  };
}

const IMPORTANT_DATE_TYPE_OPTIONS = [
  { value: "joining", label: "Joining" },
  { value: "confirmation", label: "Confirmation" },
  { value: "probation_end", label: "Probation end" },
  { value: "contract_end", label: "Contract end" },
  { value: "document_expiry", label: "Document expiry" },
];

export const importantDatesConfig: SubEntityPanelConfig<EmployeeImportantDateView> = {
  title: "Important dates",
  addLabel: "+ Add date",
  emptyLabel: "No important dates on file.",
  createFields: [
    { key: "dateType", label: "Type", type: "select", required: true, options: IMPORTANT_DATE_TYPE_OPTIONS },
    { key: "dateValue", label: "Date", type: "date", required: true },
    { key: "label", label: "Label", type: "text", placeholder: "optional" },
  ],
  updateFields: [
    { key: "dateValue", label: "Date", type: "date", required: true },
    { key: "label", label: "Label", type: "text" },
  ],
  renderSummary: (item) => ({
    primary: `${IMPORTANT_DATE_TYPE_OPTIONS.find((o) => o.value === item.dateType)?.label ?? item.dateType} — ${item.dateValue}`,
    secondary: item.label ?? undefined,
  }),
  openStatus: "active",
  closedStatusLabel: "Ended",
  closeActionLabel: "End",
  closeConfirm: () => "End this date entry?",
  list: (employeeId) => api.listEmployeeImportantDates(employeeId),
  create: (employeeId, values) =>
    api.createEmployeeImportantDate({ employeeId, ...values } as Parameters<typeof api.createEmployeeImportantDate>[0]),
  update: (id, values) => api.updateEmployeeImportantDate(id, values as Parameters<typeof api.updateEmployeeImportantDate>[1]),
  close: (id) => api.endEmployeeImportantDate(id),
};

const PAYMENT_METHOD_OPTIONS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];

export const paymentAccountsConfig: SubEntityPanelConfig<EmployeePaymentAccountView> = {
  title: "Payment / Bank accounts",
  addLabel: "+ Add payment account",
  emptyLabel: "No payment accounts on file.",
  createFields: [
    { key: "paymentMethod", label: "Method", type: "select", required: true, options: PAYMENT_METHOD_OPTIONS },
    { key: "bankName", label: "Bank name", type: "text" },
    { key: "accountTitle", label: "Account title", type: "text" },
    { key: "accountNumber", label: "Account number", type: "text" },
    { key: "iban", label: "IBAN", type: "text" },
    { key: "branchCode", label: "Branch code", type: "text" },
    { key: "isPrimary", label: "Primary", type: "checkbox", defaultChecked: true },
  ],
  updateFields: [
    { key: "paymentMethod", label: "Method", type: "select", required: true, options: PAYMENT_METHOD_OPTIONS },
    { key: "bankName", label: "Bank name", type: "text" },
    { key: "accountTitle", label: "Account title", type: "text" },
    { key: "accountNumber", label: "Account number", type: "text" },
    { key: "iban", label: "IBAN", type: "text" },
    { key: "branchCode", label: "Branch code", type: "text" },
    { key: "isPrimary", label: "Primary", type: "checkbox" },
  ],
  renderSummary: (item) => ({
    primary: `${PAYMENT_METHOD_OPTIONS.find((o) => o.value === item.paymentMethod)?.label ?? item.paymentMethod}${item.isPrimary ? " ★" : ""}`,
    secondary: [item.bankName, item.accountNumber].filter(Boolean).join(" · ") || undefined,
  }),
  openStatus: "active",
  closedStatusLabel: "Ended",
  closeActionLabel: "End",
  closeConfirm: () => "End this payment account?",
  list: (employeeId) => api.listEmployeePaymentAccounts(employeeId),
  create: (employeeId, values) =>
    api.createEmployeePaymentAccount({ employeeId, ...values } as Parameters<typeof api.createEmployeePaymentAccount>[0]),
  update: (id, values) => api.updateEmployeePaymentAccount(id, values as Parameters<typeof api.updateEmployeePaymentAccount>[1]),
  close: (id) => api.endEmployeePaymentAccount(id),
};

export function costAllocationsConfig(costCenterOptions: { value: string; label: string }[]): SubEntityPanelConfig<EmployeeCostAllocationView> {
  return {
    title: "Cost allocation",
    addLabel: "+ Add split",
    emptyLabel: "No cost allocations on file (payroll charges 100% to the default cost center until one is added).",
    createFields: [
      { key: "costCenterId", label: "Cost center", type: "select", required: true, options: costCenterOptions },
      { key: "allocationPercentage", label: "Percentage", type: "number", required: true, placeholder: "0-100" },
      { key: "isPrimary", label: "Primary", type: "checkbox" },
    ],
    updateFields: [
      { key: "allocationPercentage", label: "Percentage", type: "number", required: true },
      { key: "isPrimary", label: "Primary", type: "checkbox" },
    ],
    renderSummary: (item) => ({
      primary: `${costCenterOptions.find((o) => o.value === item.costCenterId)?.label ?? item.costCenterId} — ${item.allocationPercentage}%${item.isPrimary ? " ★" : ""}`,
    }),
    openStatus: "active",
    closedStatusLabel: "Ended",
    closeActionLabel: "End",
    closeConfirm: () => "End this cost allocation split?",
    list: (employeeId) => api.listEmployeeCostAllocations(employeeId),
    create: (employeeId, values) =>
      api.createEmployeeCostAllocation({ employeeId, ...values } as Parameters<typeof api.createEmployeeCostAllocation>[0]),
    update: (id, values) => api.updateEmployeeCostAllocation(id, values as Parameters<typeof api.updateEmployeeCostAllocation>[1]),
    close: (id) => api.endEmployeeCostAllocation(id),
  };
}

// Same treatment for `relationship` -> this tenant's own
// `family_relationship_type` catalog
// (EmployeeFamilyMembersService.createWithinTransaction()/update()'s own
// validateActiveCode() calls).
const FALLBACK_FAMILY_RELATIONSHIP_OPTIONS = [
  { value: "spouse", label: "Spouse" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "other", label: "Other" },
];

export function familyMembersConfig(relationshipOptions: { value: string; label: string }[]): SubEntityPanelConfig<EmployeeFamilyMemberView> {
  const options = relationshipOptions.length > 0 ? relationshipOptions : FALLBACK_FAMILY_RELATIONSHIP_OPTIONS;
  return {
    title: "Family / Dependents",
    addLabel: "+ Add family member",
    emptyLabel: "No family members on file.",
    createFields: [
      { key: "relationship", label: "Relationship", type: "select", required: true, options },
      { key: "fullName", label: "Full name", type: "text", required: true },
      { key: "dateOfBirth", label: "Date of birth", type: "date" },
      { key: "cnic", label: "CNIC", type: "text" },
      { key: "isDependent", label: "Dependent", type: "checkbox", defaultChecked: true },
      { key: "isBeneficiary", label: "Beneficiary", type: "checkbox" },
    ],
    updateFields: [
      { key: "relationship", label: "Relationship", type: "select", required: true, options },
      { key: "fullName", label: "Full name", type: "text", required: true },
      { key: "dateOfBirth", label: "Date of birth", type: "date" },
      { key: "cnic", label: "CNIC", type: "text" },
      { key: "isDependent", label: "Dependent", type: "checkbox" },
      { key: "isBeneficiary", label: "Beneficiary", type: "checkbox" },
    ],
    renderSummary: (item) => ({
      primary: `${item.fullName} (${options.find((o) => o.value === item.relationship)?.label ?? item.relationship})${item.isBeneficiary ? " ★" : ""}`,
      secondary: item.dateOfBirth ?? undefined,
    }),
    openStatus: "active",
    closedStatusLabel: "Ended",
    closeActionLabel: "End",
    closeConfirm: (item) => `End this family member record (${item.fullName})?`,
    list: (employeeId) => api.listEmployeeFamilyMembers(employeeId),
    create: (employeeId, values) =>
      api.createEmployeeFamilyMember({ employeeId, ...values } as Parameters<typeof api.createEmployeeFamilyMember>[0]),
    update: (id, values) => api.updateEmployeeFamilyMember(id, values as Parameters<typeof api.updateEmployeeFamilyMember>[1]),
    close: (id) => api.endEmployeeFamilyMember(id),
  };
}

export const educationConfig: SubEntityPanelConfig<EmployeeEducationView> = {
  title: "Education",
  addLabel: "+ Add education",
  emptyLabel: "No education on file.",
  createFields: [
    { key: "degreeTitle", label: "Degree / Title", type: "text", required: true },
    { key: "institution", label: "Institution", type: "text" },
    { key: "fieldOfStudy", label: "Field of study", type: "text" },
    { key: "startDate", label: "Start date", type: "date" },
    { key: "endDate", label: "End date", type: "date" },
    { key: "grade", label: "Grade", type: "text" },
  ],
  updateFields: [
    { key: "degreeTitle", label: "Degree / Title", type: "text", required: true },
    { key: "institution", label: "Institution", type: "text" },
    { key: "fieldOfStudy", label: "Field of study", type: "text" },
    { key: "startDate", label: "Start date", type: "date" },
    { key: "endDate", label: "End date", type: "date" },
    { key: "grade", label: "Grade", type: "text" },
  ],
  renderSummary: (item) => ({
    primary: item.degreeTitle,
    secondary: [item.institution, item.fieldOfStudy].filter(Boolean).join(" · ") || undefined,
  }),
  openStatus: "active",
  closedStatusLabel: "Ended",
  closeActionLabel: "End",
  closeConfirm: (item) => `End this education record (${item.degreeTitle})?`,
  list: (employeeId) => api.listEmployeeEducation(employeeId),
  create: (employeeId, values) => api.createEmployeeEducation({ employeeId, ...values } as Parameters<typeof api.createEmployeeEducation>[0]),
  update: (id, values) => api.updateEmployeeEducation(id, values as Parameters<typeof api.updateEmployeeEducation>[1]),
  close: (id) => api.endEmployeeEducation(id),
};

// Same treatment for `qualificationType` -> this tenant's own
// `qualification_type` catalog
// (EmployeeQualificationsService.createWithinTransaction()/update()'s own
// validateActiveCode() calls).
const FALLBACK_QUALIFICATION_TYPE_OPTIONS = [
  { value: "certificate", label: "Certificate" },
  { value: "license", label: "License" },
  { value: "skill", label: "Skill" },
];

export function qualificationsConfig(qualificationTypeOptions: { value: string; label: string }[]): SubEntityPanelConfig<EmployeeQualificationView> {
  const options = qualificationTypeOptions.length > 0 ? qualificationTypeOptions : FALLBACK_QUALIFICATION_TYPE_OPTIONS;
  return {
    title: "Qualifications / Skills",
    addLabel: "+ Add qualification",
    emptyLabel: "No qualifications on file.",
    createFields: [
      { key: "qualificationType", label: "Type", type: "select", required: true, options },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "issuingAuthority", label: "Issuing authority", type: "text" },
      { key: "issueDate", label: "Issue date", type: "date" },
      { key: "expiryDate", label: "Expiry date", type: "date" },
      { key: "proficiencyLevel", label: "Proficiency level", type: "text" },
    ],
    updateFields: [
      { key: "qualificationType", label: "Type", type: "select", required: true, options },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "issuingAuthority", label: "Issuing authority", type: "text" },
      { key: "issueDate", label: "Issue date", type: "date" },
      { key: "expiryDate", label: "Expiry date", type: "date" },
      { key: "proficiencyLevel", label: "Proficiency level", type: "text" },
    ],
    renderSummary: (item) => ({
      primary: `${item.title} (${options.find((o) => o.value === item.qualificationType)?.label ?? item.qualificationType})`,
      secondary: item.issuingAuthority ?? undefined,
    }),
    openStatus: "active",
    closedStatusLabel: "Ended",
    closeActionLabel: "End",
    closeConfirm: (item) => `End this qualification (${item.title})?`,
    list: (employeeId) => api.listEmployeeQualifications(employeeId),
    create: (employeeId, values) =>
      api.createEmployeeQualification({ employeeId, ...values } as Parameters<typeof api.createEmployeeQualification>[0]),
    update: (id, values) => api.updateEmployeeQualification(id, values as Parameters<typeof api.updateEmployeeQualification>[1]),
    close: (id) => api.endEmployeeQualification(id),
  };
}

export const assetsConfig: SubEntityPanelConfig<EmployeeAssetView> = {
  title: "Assets",
  addLabel: "+ Assign asset",
  emptyLabel: "No assets assigned.",
  createFields: [
    { key: "assetType", label: "Asset type", type: "text", required: true, placeholder: "laptop, phone, badge…" },
    { key: "assetTag", label: "Asset tag", type: "text" },
    { key: "description", label: "Description", type: "text" },
    { key: "assignedDate", label: "Assigned date", type: "date" },
  ],
  updateFields: [
    { key: "assetTag", label: "Asset tag", type: "text" },
    { key: "description", label: "Description", type: "text" },
  ],
  renderSummary: (item) => ({
    primary: `${item.assetType}${item.assetTag ? ` (${item.assetTag})` : ""}`,
    secondary: item.description ?? undefined,
  }),
  openStatus: "assigned",
  closedStatusLabel: "Returned",
  closeActionLabel: "Mark returned",
  closeConfirm: (item) => `Mark this asset (${item.assetType}) as returned?`,
  list: (employeeId) => api.listEmployeeAssets(employeeId),
  create: (employeeId, values) => api.createEmployeeAsset({ employeeId, ...values } as Parameters<typeof api.createEmployeeAsset>[0]),
  update: (id, values) => api.updateEmployeeAsset(id, values as Parameters<typeof api.updateEmployeeAsset>[1]),
  close: (id) => api.returnEmployeeAsset(id),
};
