import type { CardFieldType, FieldSensitivityTier } from "@aihxm/shared-types";

/**
 * Gap Register CFG-12 - descriptive metadata for the BUILT-IN hiring card
 * fields (card-field-catalog.ts lists them; this adds what kind of value each
 * holds). Only unambiguous entries are listed: a field absent here keeps
 * `field_type = NULL` ("not classified yet") rather than a guessed type.
 * `sensitivity` reuses the existing tier vocabulary (employee-field-
 * sensitivity.ts); catalog / reference links name the owning master
 * (Organization Management owns org_unit, location, position, cost_center -
 * hiring only stores their ids).
 */
export type FieldMeta = {
  fieldType: CardFieldType;
  sensitivity?: FieldSensitivityTier;
  referenceCatalogType?: string;
  referenceObject?: string;
  optionValues?: string[];
};

export const CARD_FIELD_METADATA: Readonly<Record<string, FieldMeta>> = Object.freeze({
  "personal_identity.firstName": { fieldType: "text" },
  "personal_identity.lastName": { fieldType: "text" },
  "personal_identity.cnic": { fieldType: "text", sensitivity: "restricted" },
  "personal_identity.dateOfBirth": { fieldType: "date", sensitivity: "confidential" },
  "personal_identity.middleName": { fieldType: "text" },
  "personal_identity.preferredName": { fieldType: "text" },
  "personal_identity.title": { fieldType: "text" },
  "personal_identity.placeOfBirth": { fieldType: "text" },
  "personal_identity.nationality": { fieldType: "text" },
  "personal_identity.language": { fieldType: "text" },
  "personal_identity.passportNumber": { fieldType: "text", sensitivity: "restricted" },
  "personal_identity.passportExpiry": { fieldType: "date", sensitivity: "confidential" },
  "personal_identity.ntn": { fieldType: "text", sensitivity: "restricted" },
  "employment.employmentType": { fieldType: "catalog", referenceCatalogType: "employment_type" },
  "employment.dateOfJoining": { fieldType: "date" },
  "employment.designation": { fieldType: "text" },
  "organization_assignment.orgUnitId": { fieldType: "reference", referenceObject: "org_unit" },
  "organization_assignment.locationId": { fieldType: "reference", referenceObject: "location" },
  "organization_assignment.positionId": { fieldType: "reference", referenceObject: "position" },
  "reporting_relationships.directManagerEmployeeId": { fieldType: "reference", referenceObject: "employee" },
  "contact.value": { fieldType: "text" },
  "contact.label": { fieldType: "text" },
  "contact.isPrimary": { fieldType: "boolean" },
  "addresses.city": { fieldType: "text" },
  "addresses.country": { fieldType: "text" },
  "addresses.line2": { fieldType: "text" },
  "addresses.stateProvince": { fieldType: "text" },
  "addresses.postalCode": { fieldType: "text" },
  "working_time.shiftId": { fieldType: "reference", referenceObject: "shift" },
  "working_time.effectiveFrom": { fieldType: "date" },
  "compensation.monthlySalary": { fieldType: "number", sensitivity: "confidential" },
  "compensation.effectiveFrom": { fieldType: "date" },
  "payment_bank.paymentMethod": { fieldType: "select", optionValues: ["bank_transfer", "cash", "cheque"] },
  "payment_bank.bankName": { fieldType: "text" },
  "payment_bank.accountTitle": { fieldType: "text" },
  "payment_bank.accountNumber": { fieldType: "text", sensitivity: "highly_restricted" },
  "payment_bank.iban": { fieldType: "text", sensitivity: "highly_restricted" },
  "payment_bank.branchCode": { fieldType: "text" },
  "important_dates.dateValue": { fieldType: "date" },
  "important_dates.label": { fieldType: "text" },
  "cost_allocation.costCenterId": { fieldType: "reference", referenceObject: "cost_center" },
  "cost_allocation.allocationPercentage": { fieldType: "number" },
  "cost_allocation.isPrimary": { fieldType: "boolean" },
  "family_dependents.fullName": { fieldType: "text" },
  "family_dependents.dateOfBirth": { fieldType: "date", sensitivity: "confidential" },
  "family_dependents.isDependent": { fieldType: "boolean" },
  "family_dependents.isBeneficiary": { fieldType: "boolean" },
  "family_dependents.cnic": { fieldType: "text", sensitivity: "restricted" },
  "education.degreeTitle": { fieldType: "text" },
  "education.institution": { fieldType: "text" },
  "education.fieldOfStudy": { fieldType: "text" },
  "education.startDate": { fieldType: "date" },
  "education.endDate": { fieldType: "date" },
  "education.grade": { fieldType: "text" },
  "qualifications_skills.title": { fieldType: "text" },
  "qualifications_skills.issuingAuthority": { fieldType: "text" },
  "qualifications_skills.issueDate": { fieldType: "date" },
  "qualifications_skills.expiryDate": { fieldType: "date" },
  "qualifications_skills.proficiencyLevel": { fieldType: "text" },
  "assets.assetTag": { fieldType: "text" },
  "assets.description": { fieldType: "text" },
  "assets.assignedDate": { fieldType: "date" },
  "documents.notes": { fieldType: "textarea" },
  "time_leave_setup.notes": { fieldType: "textarea" },
  "benefits.notes": { fieldType: "textarea" },
  "emergency_safety.notes": { fieldType: "textarea" },
});
