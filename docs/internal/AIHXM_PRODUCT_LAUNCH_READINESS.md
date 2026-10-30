# AIHXM Product Launch Readiness

**PRIVATE. INTERNAL PLANNING ONLY.** This file is not part of the website build, is never copied into `apps/site/dist`, and must not be published. The public site presents the intended product; this file records what is actually true.

Generated 2026-10-30 by `apps/site/scripts/readiness-doc.mjs` from the same content files the website is built from, so a capability cannot be advertised without appearing here. Re-run it after any content change. Implementation statuses come from the `|status` markers in `apps/site/src/content/*.mjs` and from `docs/marketing/capability-inventory.md`.

## How to read this register

- **Status values**: *Available* (Implemented in code. Not yet proven with a pilot customer's real data.) · *Configurable* (Implemented. Works only after the customer enters its own data, rates or rules.) · *Requires external integration* (Product side implemented. Needs an external device, provider or system.) · *Partially available* (Partly built. Some behaviour is missing.) · *In development* (In development.) · *Planned* (Not built. On the roadmap and advertised as part of the product vision.)
- Each module has a block with the fields that apply to every feature in it: intended functionality, required integrations, testing requirements, security considerations, acceptance criteria and dependencies. The table under it lists each advertised feature with its own implementation status, remaining work, acceptance criteria and launch readiness.
- **Pre-launch gate**: before any customer is asked to buy, every row whose readiness starts with *Not ready* or *Blocked* must be completed, removed from the website, or explicitly scoped in the contract. The list is in the last section.
- Nothing here has been proven with a paying customer. `Ready, pending pilot UAT` means built, not validated by an outside user.

## Core HR & Employee Management

- **Public page**: /platform/core-hr/  ·  **Group**: People
- **Intended functionality**: Personal, job, statutory and bank details, documents and history sit in a single employee file. Change something once and leave, attendance, payroll and reports all see it.
- **Required integrations**: Customer identity provider for SSO and SCIM (optional).
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Personal and identity data: field-level permissions, per-company encryption of sensitive fields, change audit, data-subject requests.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Employee Self-Service, Organization Management, Onboarding & Offboarding; company configuration (Configuration Center).
- **Status mix**: Available 24

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Complete Employee Profiles | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Complete Employee Profiles as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Personal Information | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Personal Information as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Contact Information | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Contact Information as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employment Information | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employment Information as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Job Information | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Job Information as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| CNIC and NTN | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use CNIC and NTN as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| EOBI Information | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use EOBI Information as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Bank Accounts | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Bank Accounts as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Emergency Contacts | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Emergency Contacts as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Photographs | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Photographs as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Languages | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Languages as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee History | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee History as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Documents | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Documents as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Document Expiry | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Document Expiry as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Medical Records | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Medical Records as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Disciplinary Records | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Disciplinary Records as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Quick Hire | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Quick Hire as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Guided Hire | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Guided Hire as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Bulk Employee Import | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Bulk Employee Import as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Self-Service | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Self-Service as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Data Change Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Data Change Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| HR Approval | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use HR Approval as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Custom Fields | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Custom Fields as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Form Designer | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Form Designer as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Leave Management

- **Public page**: /platform/leave/  ·  **Group**: Time
- **Intended functionality**: Define leave types and policies once. Balances accrue, carry forward and expire on their own, requests route to the right approver, and everyone sees an accurate balance.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Location and time data: privacy of GPS punches, rotating device keys, correction audit trail.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Attendance & Time, Approvals & Workflow, Payroll; company configuration (Configuration Center).
- **Status mix**: Available 14

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Leave Types | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Types as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Policies | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Policies as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Accrual | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Accrual as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Carry Forward | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Carry Forward as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Expiry | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Expiry as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Compensatory Leave | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Compensatory Leave as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Half-Day Leave | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Half-Day Leave as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Hourly Leave | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Hourly Leave as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Short-Hours Rules | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Short-Hours Rules as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Approval Workflows | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Approval Workflows as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Holiday Calendars | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Holiday Calendars as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Location-Based Holidays | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Location-Based Holidays as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Balance Ledger | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Balance Ledger as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Analytics | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Analytics as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Attendance & Time

- **Public page**: /platform/attendance/  ·  **Group**: Time
- **Intended functionality**: Employees clock in on the web or phone, shifts define what on time means, and late, absent and overtime results are worked out for you. Corrections and overtime go through approval.
- **Required integrations**: Biometric / attendance devices (customer side); optional mail provider.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Location and time data: privacy of GPS punches, rotating device keys, correction audit trail.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Leave Management, Payroll, Approvals & Workflow; company configuration (Configuration Center).
- **Status mix**: Available 13, Requires external integration 2
- **Known limitations (internal)**: Night shifts that cross midnight are currently judged on the day of clock-in. Absence results rely on the nightly job.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Web Clock-In | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Web Clock-In as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Web Clock-Out | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Web Clock-Out as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Shift Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Shift Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Auto Clock-Out | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Auto Clock-Out as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Biometric Punch Intake | Product side implemented. Needs an external device, provider or system. | Compatibility testing with the device vendors customers use; device setup guide. | A user in the intended role can use Biometric Punch Intake as the page describes, within their data scope, and the change is audited. | Blocked until an integration is tested |
| Device Punch Intake | Product side implemented. Needs an external device, provider or system. | Compatibility testing with real devices; device-key rotation runbook. | A user in the intended role can use Device Punch Intake as the page describes, within their data scope, and the change is audited. | Blocked until an integration is tested |
| Late Arrival Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Late Arrival Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Absence Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Absence Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Attendance Corrections | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Corrections as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| On-Duty Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use On-Duty Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Overtime Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Overtime Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Overtime Caps | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Overtime Caps as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Pre-Approval | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Pre-Approval as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Weekly Timesheets | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Weekly Timesheets as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Attendance Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Payroll

- **Public page**: /platform/payroll/  ·  **Group**: Pay
- **Intended functionality**: Prepare, calculate, review, approve, finalise and pay. Variance checks flag surprises before money moves, every payslip carries its calculation, and corrections never overwrite history.
- **Required integrations**: Customer's bank file layout; accounting system for journal import; accountant for statutory settings.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; parallel run against the customer's current payroll with accountant sign-off.
- **Security considerations**: Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Attendance & Time, Compensation Planning, Expenses & Travel; company configuration (Configuration Center).
- **Status mix**: Available 21, Configurable 3, Partially available 1
- **Known limitations (internal)**: Tax slabs and statutory rates are entered and maintained by your company with its accountant. Bank files use a layout your company defines; named-bank layouts are not included.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Monthly Payroll Runs | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Monthly Payroll Runs as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Preparation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Preparation as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Review | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Review as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Finalization | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Finalization as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Simulation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Simulation as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Salary Components | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Salary Components as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Formulas | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Formulas as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Income Tax Calculation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Income Tax Calculation as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Pakistan Tax Slabs | Implemented. Works only after the customer enters its own data, rates or rules. | Accountant-reviewed starter figures for each tax year, plus the yearly update procedure. No rates may be hard-coded. | A user in the intended role can use Pakistan Tax Slabs as the page describes, within their data scope, and the change is audited. | Ready after documented configuration |
| Tax Profiles | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Tax Profiles as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Tax Exemptions | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Tax Exemptions as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| EOBI | Implemented. Works only after the customer enters its own data, rates or rules. | Confirm wage-base handling with an accountant; yearly update procedure; no filing is built. | A user in the intended role can use EOBI as the page describes, within their data scope, and the change is audited. | Ready after documented configuration |
| Provincial Social Security | Implemented. Works only after the customer enters its own data, rates or rules. | Confirm schemes per province; yearly update procedure; no filing is built. | A user in the intended role can use Provincial Social Security as the page describes, within their data scope, and the change is audited. | Ready after documented configuration |
| Employee Loans | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Loans as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Salary Advances | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Salary Advances as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Arrears | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Arrears as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Retroactive Payroll | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Retroactive Payroll as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Final Settlement | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Final Settlement as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payslips | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payslips as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Tax Certificates | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Tax Certificates as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Annual Salary Statements | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Annual Salary Statements as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payment Batches | Partly built. Some behaviour is missing. | Ready-made bank file layouts for the banks customers use; decide on instant-payment scheme support; test files with each bank. | A user in the intended role can use Payment Batches as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Bank Reconciliation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Bank Reconciliation as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Accounting Journal Export | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Accounting Journal Export as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Approvals & Workflow

- **Public page**: /platform/workflows/  ·  **Group**: Platform
- **Intended functionality**: Leave, expenses, travel, requests and headcount all run through the same approval engine. Steps, fallback approvers and comment rules are configured by your team, and the history is kept.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Workflow integrity (no skipped steps), document storage access control, e-sign receipts, configuration change audit.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Leave Management, Expenses & Travel, Organization Management; company configuration (Configuration Center).
- **Status mix**: Available 11

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Central Approval Engine | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Central Approval Engine as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Multi-Step Workflows | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Multi-Step Workflows as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Fallback Approvers | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Fallback Approvers as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Workflow Configuration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Workflow Configuration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Expense Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Expense Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Travel Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Travel Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Headcount Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Headcount Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Approval Comments | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Approval Comments as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Approval History | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Approval History as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Organization Management

- **Public page**: /platform/organization/  ·  **Group**: People
- **Intended functionality**: Departments, locations, positions, jobs and cost centres form a structure the rest of AiHxM relies on. Reporting lines drive approvals, and headcount plans sit beside real headcount.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Personal and identity data: field-level permissions, per-company encryption of sensitive fields, change audit, data-subject requests.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Core HR & Employee Management, Approvals & Workflow, Reports & Analytics; company configuration (Configuration Center).
- **Status mix**: Available 10

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Organizational Units | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Organizational Units as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Departments | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Departments as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Locations | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Locations as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Positions | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Positions as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Jobs | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Jobs as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Cost Centers | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Cost Centers as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Reporting Lines | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Reporting Lines as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Groups | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Groups as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Headcount Planning | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Headcount Planning as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Organizational Reporting | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Organizational Reporting as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Recruitment

- **Public page**: /platform/recruitment/  ·  **Group**: Talent
- **Intended functionality**: Raise a requisition, publish the job, track candidates through stages, schedule interviews and issue offers. When someone is hired their details flow into onboarding.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Review and candidate confidentiality: visibility rules, candidate data retention, anonymity where promised.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Onboarding & Offboarding, Core HR & Employee Management, Organization Management; company configuration (Configuration Center).
- **Status mix**: Available 10
- **Known limitations (internal)**: Resume reading is rule-based text extraction, not AI. Job-board posting and background-check services are not part of the product.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Job Requisitions | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Job Requisitions as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Job Postings | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Job Postings as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Public Careers Page | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Public Careers Page as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Job Feed | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Job Feed as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Candidate Pipeline | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Candidate Pipeline as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Candidate Records | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Candidate Records as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Interview Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Interview Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Resume Text Reading | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Resume Text Reading as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Offer Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Offer Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Recruitment Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Recruitment Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Performance Management

- **Public page**: /platform/performance/  ·  **Group**: Talent
- **Intended functionality**: Set goals, open a review cycle, collect self and manager assessments, calibrate ratings and keep feedback and development plans together.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Review and candidate confidentiality: visibility rules, candidate data retention, anonymity where promised.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Talent Management, Compensation Planning, Learning Management; company configuration (Configuration Center).
- **Status mix**: Available 7
- **Known limitations (internal)**: The rating scale is fixed. 360-degree feedback and improvement plans are not part of the product yet.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Goal Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Goal Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Review Cycles | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Review Cycles as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Performance Ratings | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Performance Ratings as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Manager Feedback | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Manager Feedback as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Performance Reviews | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Performance Reviews as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Calibration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Calibration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Performance Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Performance Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Talent Management

- **Public page**: /platform/talent/  ·  **Group**: Talent
- **Intended functionality**: Maintain a skills catalogue, compare what people have with what roles need, place people on a nine-box grid, keep succession lists for key roles and group high-potential people into talent pools.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Review and candidate confidentiality: visibility rules, candidate data retention, anonymity where promised.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Performance Management, Learning Management, Compensation Planning; company configuration (Configuration Center).
- **Status mix**: Available 6
- **Known limitations (internal)**: Restricted to authorised roles. Newly released, so it has had less real-world use than Core HR or Payroll.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Skills Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Skills Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Skills Gap Analysis | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Skills Gap Analysis as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Nine-Box Matrix | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Nine-Box Matrix as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Succession Lists | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Succession Lists as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Talent Pools | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Talent Pools as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Talent Analytics | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Talent Analytics as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Compensation Planning

- **Public page**: /platform/compensation/  ·  **Group**: Pay
- **Intended functionality**: Open an increment cycle, propose revisions, route them for approval and apply approved changes to payroll with an explicit action. Nothing reaches a payslip automatically.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; parallel run against the customer's current payroll with accountant sign-off.
- **Security considerations**: Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Payroll, Performance Management, Approvals & Workflow; company configuration (Configuration Center).
- **Status mix**: Available 5
- **Known limitations (internal)**: Arrears are not calculated automatically and employees are not notified automatically when a revision is applied.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Increment Cycles | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Increment Cycles as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Salary Revision Planning | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Salary Revision Planning as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Compensation Approval | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Compensation Approval as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Compensation-to-Payroll Integration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Compensation-to-Payroll Integration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Compensation Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Compensation Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Learning Management

- **Public page**: /platform/learning/  ·  **Group**: Talent
- **Intended functionality**: Publish a course catalogue, enrol employees, assign mandatory courses automatically and send due-date reminders. Learning reports show who is up to date.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Review and candidate confidentiality: visibility rules, candidate data retention, anonymity where promised.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Talent Management, Onboarding & Offboarding, Performance Management; company configuration (Configuration Center).
- **Status mix**: Available 6
- **Known limitations (internal)**: Certificate expiry tracking is not built.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Course Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Course Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Enrollment | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Enrollment as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Mandatory Courses | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Mandatory Courses as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Automatic Course Assignment | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Automatic Course Assignment as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Due-Date Reminders | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Due-Date Reminders as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Learning Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Learning Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Expenses & Travel

- **Public page**: /platform/expenses-travel/  ·  **Group**: Pay
- **Intended functionality**: Employees submit claims with receipts and raise travel requests. Approvers decide in the same inbox as everything else, and approved claims can be reimbursed through payroll.
- **Required integrations**: Payroll; optional card or travel booking feeds (not built).
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; parallel run against the customer's current payroll with accountant sign-off.
- **Security considerations**: Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Approvals & Workflow, Payroll, Core HR & Employee Management; company configuration (Configuration Center).
- **Status mix**: Available 6
- **Known limitations (internal)**: Expense categories are free text for now, with no per-category limits or mileage rules.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Expense Claims | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Expense Claims as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Receipt Uploads | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Receipt Uploads as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Expense Approval | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Expense Approval as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Reimbursement | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Reimbursement as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Travel Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Travel Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Business Travel Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Business Travel Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Onboarding & Offboarding

- **Public page**: /platform/onboarding-offboarding/  ·  **Group**: People
- **Intended functionality**: Use templates to give every joiner a checklist across HR, IT and their manager, and every leaver a structured exit. Tasks have owners and nothing is forgotten.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Personal and identity data: field-level permissions, per-company encryption of sensitive fields, change audit, data-subject requests.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Recruitment, Asset Management, Documents & Agreements; company configuration (Configuration Center).
- **Status mix**: Available 5, Partially available 1
- **Known limitations (internal)**: Multi-step clearance chains are not built; clearance is tracked as checklist items.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Onboarding Templates | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Onboarding Templates as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Checklists | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Checklists as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Offboarding Checklists | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Offboarding Checklists as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Exit Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Exit Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Exit Finalization | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Exit Finalization as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Clearance Management | Partly built. Some behaviour is missing. | Multi-step, multi-department clearance chains (today a checklist). | A user in the intended role can use Clearance Management as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |

## Surveys & Engagement

- **Public page**: /platform/surveys-engagement/  ·  **Group**: Experience
- **Intended functionality**: Run short pulse surveys or longer engagement surveys. Anonymity rules hide results from small groups so nobody can be identified, and analytics show where sentiment is moving.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Recognition & Announcements, HR Help Desk, Reports & Analytics; company configuration (Configuration Center).
- **Status mix**: Available 5

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Pulse Surveys | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Pulse Surveys as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Engagement Surveys | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Engagement Surveys as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Anonymity Rules | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Anonymity Rules as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Survey Analytics | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Survey Analytics as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Feedback | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Feedback as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Recognition & Announcements

- **Public page**: /platform/recognition-announcements/  ·  **Group**: Experience
- **Intended functionality**: A recognition feed lets colleagues appreciate each other publicly, and announcements reach everyone from one place. HR can hide a post that should not be there.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Surveys & Engagement, HR Help Desk, Employee Self-Service; company configuration (Configuration Center).
- **Status mix**: Available 4

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Recognition Feed | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Recognition Feed as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Appreciation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Appreciation as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Company Announcements | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Company Announcements as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Internal Communication | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Internal Communication as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## HR Help Desk

- **Public page**: /platform/hr-help-desk/  ·  **Group**: Experience
- **Intended functionality**: Employees raise requests under HR categories. Each category has a first-reply clock, and an ageing queue shows what is waiting and for how long.
- **Required integrations**: Mail provider for replies.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Employee Self-Service, Approvals & Workflow, Documents & Agreements; company configuration (Configuration Center).
- **Status mix**: Available 5
- **Known limitations (internal)**: Full SLA escalation rules are not built; clocks and ageing are tracked.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| HR Request Categories | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use HR Request Categories as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Support Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Support Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| First-Reply Clocks | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use First-Reply Clocks as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Ageing Queues | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Ageing Queues as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| HR Service Management | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use HR Service Management as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Documents & Agreements

- **Public page**: /platform/documents-agreements/  ·  **Group**: Platform
- **Intended functionality**: Generate HR letters from templates, publish policies and collect typed-name agreements with a receipt for each. See who has acknowledged and who has not.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Workflow integrity (no skipped steps), document storage access control, e-sign receipts, configuration change audit.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Onboarding & Offboarding, Core HR & Employee Management, HR Help Desk; company configuration (Configuration Center).
- **Status mix**: Available 6
- **Known limitations (internal)**: A typed-name agreement is an acknowledgement with a receipt. It is not a certified digital signature, and whether it is enough for a given document is a legal question for your company.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Document Templates | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Document Templates as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| HR Letters | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use HR Letters as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Policies | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Policies as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Typed-Name Agreements | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Typed-Name Agreements as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Document Acknowledgements | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Document Acknowledgements as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Receipt Tracking | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Receipt Tracking as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Asset Management

- **Public page**: /platform/asset-management/  ·  **Group**: People
- **Intended functionality**: Keep a register of company assets, assign them to employees and see each asset's history. At exit, what is still assigned is visible.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Personal and identity data: field-level permissions, per-company encryption of sensitive fields, change audit, data-subject requests.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Onboarding & Offboarding, Core HR & Employee Management, Organization Management; company configuration (Configuration Center).
- **Status mix**: Available 4

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Asset Register | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Asset Register as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Asset Assignment | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Asset Assignment as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Asset Records | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Asset Records as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Asset History | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Asset History as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Reports & Analytics

- **Public page**: /platform/reports-analytics/  ·  **Group**: Insight
- **Intended functionality**: The product catalogue holds around 245 reports across employees, payroll, attendance, leave, recruitment, performance and organisation. Filters, detail tabs and CSV export are built in, and sensitive reports respect access rules.
- **Required integrations**: None required.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Reports and exports respect each viewer's data scope; export volume controls; no personal data leaves through dashboards.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Payroll, Organization Management, Configuration Center; company configuration (Configuration Center).
- **Status mix**: Available 13
- **Known limitations (internal)**: The catalogue is a capability of the product. A report shows data only if the company has that data. A few reports stay unavailable until their data exists. There is no custom report builder and no predictive analytics.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Employee Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Attendance Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Recruitment Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Recruitment Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Performance Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Performance Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Organization Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Organization Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Management Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Management Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Detail Tabs | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Detail Tabs as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Filters | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Filters as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| CSV Export | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use CSV Export as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Sensitive Data Access Controls | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Sensitive Data Access Controls as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Workforce Analytics | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Workforce Analytics as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Configuration Center

- **Public page**: /platform/configuration-center/  ·  **Group**: Platform
- **Intended functionality**: Workflows, numbering, forms, payslips, leave policies, attendance rules, custom fields, roles and modules are set by your own team in one place. Changes you make apply to your company only.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Workflow integrity (no skipped steps), document storage access control, e-sign receipts, configuration change audit.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Core HR & Employee Management, Approvals & Workflow, Payroll; company configuration (Configuration Center).
- **Status mix**: Available 10
- **Known limitations (internal)**: The form designer lays out the employee form; other forms allow renaming, help text, required and hidden fields. Some settings still live inside their own module.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Workflow Configuration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Workflow Configuration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Numbering Configuration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Numbering Configuration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Form Designer | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Form Designer as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payslip Designer | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payslip Designer as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Custom Fields | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Custom Fields as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Leave Policies | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Policies as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Attendance Rules | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Rules as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Roles and Permissions | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Roles and Permissions as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Module Configuration | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Module Configuration as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Company Settings | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Company Settings as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Employee Self-Service

- **Public page**: /platform/employee-self-service/  ·  **Group**: Experience
- **Intended functionality**: Employees see payslips, leave balances, attendance and requests on a home page built for their role, on the web or installed on their phone as an app.
- **Required integrations**: Mail and push providers for notifications.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Manager Self-Service, Core HR & Employee Management, Leave Management; company configuration (Configuration Center).
- **Status mix**: Available 8
- **Known limitations (internal)**: Installable on Android and iPhone as a web app (PWA). Native app-store apps are not built. The interface has an English and Urdu switcher; many screens are still English.

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Complete Employee Profiles | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Complete Employee Profiles as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Documents | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Documents as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Data Change Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Data Change Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Web Clock-In | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Web Clock-In as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Hourly Leave | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Hourly Leave as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payslips | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payslips as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Expense Claims | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Expense Claims as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Employee Support Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Employee Support Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Manager Self-Service

- **Public page**: /platform/manager-self-service/  ·  **Group**: Experience
- **Intended functionality**: Managers see their team, their approvals and their calendar on one page. Before approving leave they see the balance and who else is away.
- **Required integrations**: None required for the core module.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Employee Self-Service, Approvals & Workflow, Leave Management; company configuration (Configuration Center).
- **Status mix**: Available 7

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Leave Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Leave Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Expense Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Expense Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Travel Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Travel Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Approval Comments | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Approval Comments as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Reporting Lines | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Reporting Lines as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Attendance Reports | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Reports as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Performance Reviews | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Performance Reviews as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |

## Benefits Management

- **Public page**: /platform/benefits-management/  ·  **Group**: Pay
- **Intended functionality**: Define the benefit plans you offer, decide who is eligible, let employees enrol, and carry contributions straight into payroll. Employees see what they have; finance sees what it costs.
- **Required integrations**: Insurers or benefit providers (data exchange not built); payroll.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; parallel run against the customer's current payroll with accountant sign-off.
- **Security considerations**: Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Payroll, Compensation Planning, Employee Self-Service; company configuration (Configuration Center).
- **Status mix**: Partially available 5, Planned 6

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Benefit Plans | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Benefit Plans as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Eligibility Rules | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Eligibility Rules works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Employee Groups and Grades | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Employee Groups and Grades as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Employee Enrolment | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Employee Enrolment as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Open Enrolment Windows | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Open Enrolment Windows works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Dependents and Beneficiaries | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Dependents and Beneficiaries works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Life Event Changes | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Life Event Changes works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Employer and Employee Contributions | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Employer and Employee Contributions as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Payroll Deductions | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Payroll Deductions as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Benefits Cost Reports | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Benefits Cost Reports works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Employee Benefit Statements | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Employee Benefit Statements works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Shift Management

- **Public page**: /platform/shift-management/  ·  **Group**: Time
- **Intended functionality**: Define shifts and rotations, assign them by group, location or person, and let attendance, overtime and leave measure against the shift each person actually works.
- **Required integrations**: None required. Attendance devices for punch data.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Location and time data: privacy of GPS punches, rotating device keys, correction audit trail.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Attendance & Time, Leave Management, Employee Self-Service; company configuration (Configuration Center).
- **Status mix**: Available 8, Planned 3

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Shift Definitions | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Shift Definitions as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Shift Rotations | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Shift Rotations as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Night Shifts Across Midnight | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Night Shifts Across Midnight as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Work Profiles and Grace Periods | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Work Profiles and Grace Periods as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Assignment by Group, Location or Employee | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Assignment by Group, Location or Employee as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Work Schedule Resolution | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Work Schedule Resolution as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Roster Planning | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Roster Planning works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Shift Swap Requests | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Shift Swap Requests works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Attendance Against Shift | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Attendance Against Shift as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Overtime Against Shift | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Overtime Against Shift as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Shift Coverage Reports | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Shift Coverage Reports works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Advanced Workforce Analytics

- **Public page**: /platform/workforce-analytics/  ·  **Group**: Insight
- **Intended functionality**: Go beyond lists and totals. Follow headcount, movement, absence, cost and engagement over time, compare departments and locations, and give leaders dashboards built on the same employee record.
- **Required integrations**: None required.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Reports and exports respect each viewer's data scope; export volume controls; no personal data leaves through dashboards.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Reports & Analytics, Core HR & Employee Management, Payroll; company configuration (Configuration Center).
- **Status mix**: Partially available 1, Planned 8

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Headcount and Movement Trends | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Headcount and Movement Trends as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Turnover Analysis | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Turnover Analysis works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Span of Control and Hierarchy | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Span of Control and Hierarchy works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Absence and Attendance Trends | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Absence and Attendance Trends works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Overtime and Labour Cost Analysis | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Overtime and Labour Cost Analysis works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Payroll Cost by Department and Location | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Payroll Cost by Department and Location works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Role-Based Dashboards | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Role-Based Dashboards works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Scheduled Report Delivery | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Scheduled Report Delivery works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Drill-Down from Dashboard to Record | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Drill-Down from Dashboard to Record works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Intelligent HR

- **Public page**: /platform/intelligent-hr/  ·  **Group**: Insight
- **Intended functionality**: AiHxM is being shaped to help people find answers, catch mistakes and see patterns using the data already in the system. Assistance will respect the same roles and data access as everything else, and nothing will act on your people without a deliberate approval.
- **Required integrations**: A language-model or analytics provider (not selected); data-processing terms; evaluation set.
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Reports and exports respect each viewer's data scope; export volume controls; no personal data leaves through dashboards.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Employee Self-Service, Reports & Analytics, Advanced Workforce Analytics; company configuration (Configuration Center).
- **Status mix**: Partially available 2, Planned 7

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Self-Service HR Assistant | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Self-Service HR Assistant as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Policy Question Answering | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Policy Question Answering works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Natural-Language Report Search | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Natural-Language Report Search works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Smart Data Checks | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | A user in the intended role can use Smart Data Checks as the page describes, within their data scope, and the change is audited. | Not ready: complete, or scope explicitly in the contract |
| Payroll Anomaly Review | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Payroll Anomaly Review works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Duplicate and Inconsistency Detection | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Duplicate and Inconsistency Detection works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Attrition Risk Indicators | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Attrition Risk Indicators works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Workforce Forecasting | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Workforce Forecasting works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Skills Gap Insight | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Skills Gap Insight works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Business Travel

- **Public page**: /platform/business-travel/  ·  **Group**: Pay
- **Intended functionality**: Employees request a trip, managers and finance approve it, and the expenses that follow link back to the same trip. Everyone can see where a request stands.
- **Required integrations**: Payroll; travel booking providers (not built).
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; parallel run against the customer's current payroll with accountant sign-off.
- **Security considerations**: Highly sensitive pay data: step-up for sensitive actions, field encryption, immutability after finalise, role and scope checks, bank details masked.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Expenses & Travel, Approvals & Workflow, Payroll; company configuration (Configuration Center).
- **Status mix**: Available 6, Planned 4

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Travel Requests | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Travel Requests as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Travel Approvals | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Travel Approvals as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Trip Purpose and Estimates | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Trip Purpose and Estimates as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Itineraries | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Itineraries works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Travel Policy Rules | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Travel Policy Rules works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Per-Diem and Allowance Rules | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Per-Diem and Allowance Rules works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Trip Expense Claims | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Trip Expense Claims as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Receipt Uploads | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Receipt Uploads as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Payroll Reimbursement | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Payroll Reimbursement as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Travel Reports | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Travel Reports works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Announcements

- **Public page**: /platform/announcements/  ·  **Group**: Experience
- **Intended functionality**: Post news to everyone or to a chosen audience by location, department or group, and keep announcements together in one place employees already use.
- **Required integrations**: Mail provider; mobile push provider (not built).
- **Testing requirements**: automated tests for the module's API and permissions; cross-company isolation test; role and data-scope negative tests; a scripted end-to-end walk-through by a pilot customer; UAT with the customer's own scenarios.
- **Security considerations**: Survey anonymity (minimum group size), help-desk privacy, announcement audience correctness.
- **Acceptance criteria**: a configured company's users in the intended roles can complete the listed jobs; results respect role and data scope; every change is in the audit trail; no data crosses companies; the behaviour matches what the public page describes.
- **Dependencies**: Recognition & Announcements, Employee Self-Service, Surveys & Engagement; company configuration (Configuration Center).
- **Status mix**: Available 5, Planned 3

| Feature | Implementation status | Remaining development | Acceptance criteria | Launch readiness |
| --- | --- | --- | --- | --- |
| Company Announcements | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Company Announcements as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Audience Targeting | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Audience Targeting as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Scheduled Posts | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Scheduled Posts works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| In-App Notifications | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use In-App Notifications as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Email Notifications | Implemented in code. Not yet proven with a pilot customer's real data. | Production mail provider, deliverability test, templates. | A user in the intended role can use Email Notifications as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Read Tracking | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Read Tracking works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |
| Announcement Archive | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | A user in the intended role can use Announcement Archive as the page describes, within their data scope, and the change is audited. | Ready, pending pilot UAT |
| Pinned Announcements | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Pinned Announcements works end to end for a configured company, is permission-checked and audited, and is described accurately on the website. | Not ready: build before launch, or remove from the site |

## Integrations page

| Connection | Implementation status | Remaining development | Launch readiness |
| --- | --- | --- | --- |
| Banking and Payments: Payment batches with a company-defined bank file | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. | Not ready: complete, or scope explicitly in the contract |
| Banking and Payments: Payment reconciliation | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Banking and Payments: Bank file layouts | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Not ready: build before launch, or remove from the site |
| Attendance and Biometrics: Device punch intake | Product side implemented. Needs an external device, provider or system. | Integration specification, compatibility test with real devices or providers, setup guide. | Blocked until an integration is tested |
| Attendance and Biometrics: Biometric devices | Product side implemented. Needs an external device, provider or system. | Integration specification, compatibility test with real devices or providers, setup guide. | Blocked until an integration is tested |
| Accounting: Accounting journal export | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Accounting: Direct connection to accounting software | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Not ready: build before launch, or remove from the site |
| Identity and Authentication: Single sign-on | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Identity and Authentication: SCIM 2.0 provisioning | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Identity and Authentication: Multi-factor authentication | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Communication: Email notifications | Product side implemented. Needs an external device, provider or system. | Integration specification, compatibility test with real devices or providers, setup guide. | Blocked until an integration is tested |
| Communication: In-app notifications | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| Communication: Mobile push and messaging notifications | Not built. On the roadmap and advertised as part of the product vision. | Design, build, test, document. | Not ready: build before launch, or remove from the site |
| APIs and Developer Tools: Read-only API keys | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| APIs and Developer Tools: Webhooks | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |
| APIs and Developer Tools: Job feed | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. | Ready, pending pilot UAT |

## Pakistan payroll implementation service (public page /pakistan-hrms/payroll-implementation/)

| Workstream | Product status | Needs before launch |
| --- | --- | --- |
| Tax year setup | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. |
| Salary structures | Implemented in code. Not yet proven with a pilot customer's real data. | Pilot UAT; fix what it finds. |
| Salary tax configuration | Implemented. Works only after the customer enters its own data, rates or rules. | Setup guide, starter template, and an implementation checklist. |
| EOBI configuration | Implemented. Works only after the customer enters its own data, rates or rules. | Setup guide, starter template, and an implementation checklist. |
| Provincial social security | Implemented. Works only after the customer enters its own data, rates or rules. | Setup guide, starter template, and an implementation checklist. |
| Bank payment file | Partly built. Some behaviour is missing. | Finish the missing behaviour (see module notes), then test. |
| Parallel testing | Service step (people, not software) | Staffed implementation team, runbook, parallel-test report template, accountant partner arrangement. |
| Accountant validation | Service step (people, not software) | Staffed implementation team, runbook, parallel-test report template, accountant partner arrangement. |
| Annual statutory review | Implemented. Works only after the customer enters its own data, rates or rules. | Setup guide, starter template, and an implementation checklist. |

## Services and implementation (public pages /services/*, /implementation/)

| Item | What is advertised | Needs before launch |
| --- | --- | --- |
| HRMS Implementation | Set up AiHxM around your organisation. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Payroll Implementation | Payroll set up, parallel-run and ready to go live. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Data Migration | Move employee data from Excel or another system. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| HR Consulting | Process, policy and technology advice. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Payroll Consulting | Payroll process and reconciliation support. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Integration Services | Devices, accounting and API connections. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Training | Training for HR, payroll, managers and employees. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Support | Help during and after go-live. | Staff, runbooks, templates, and written scope/fee rules. No price or duration is published; approve them before quoting. |
| Implementation phase: Discovery | Agree what will be set up, from what, and by whom. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: HR configuration | Set up the company so it matches how you work. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: Employee migration | Bring your people records across cleanly. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: Payroll setup | Express your pay rules in the system. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: Payroll parallel testing | Compare AiHxM with your current payroll before you trust it. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: User training | Show each group what it needs. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: Go-live | Switch from the old way to the new one, deliberately. | Checklist, deliverable templates and an owner for each phase. |
| Implementation phase: Post-launch support | Keep things working after the project ends. | Checklist, deliverable templates and an owner for each phase. |
| Support tier: Standard | Questions about using the platform; Help with configuration; Fixes for faults in the product | Approve channels, hours and response targets; staff a support desk; ticketing and escalation process. The site states none of these. |
| Support tier: Priority | Everything in Standard; A named contact; Faster routing of urgent payroll-period issues | Approve channels, hours and response targets; staff a support desk; ticketing and escalation process. The site states none of these. |
| Support tier: Dedicated | Everything in Priority; Scheduled reviews; Support arrangements shaped to a larger or multi-site company | Approve channels, hours and response targets; staff a support desk; ticketing and escalation process. The site states none of these. |

## Security and trust claims (public pages /security/, /trust/)

| Area | Public wording | Real state | Action before launch |
| --- | --- | --- | --- |
| Tenant isolation | Every company's records are separated in the database with row-level security. Automated tests try to read one company's data from another and must fail. | Implemented and tested (row-level security, cross-company test) | Keep tests in CI; consider an independent penetration test. |
| Database access | Browsers never talk to the database. All access goes through the application server, which sets the company for every request before any query runs. | Implemented | Confirm no direct database credentials are shared with staff or clients. |
| Sign-in and multi-factor authentication | Passwords are stored hashed. Repeated failed attempts are throttled and locked out. One-time-code MFA is available, its secrets are stored encrypted, and sensitive actions can require a fresh verification. | Implemented | MFA enrolment policy for admin roles. |
| Access control | Built-in and custom roles, access scoped to oneself, a team or the company, and separate permissions for sensitive fields such as pay and identity numbers. | Implemented | Review default role templates. |
| Single sign-on and provisioning | SAML 2.0, OpenID Connect and SCIM 2.0 connect AiHxM to your identity system. | Implemented; needs live testing against real identity providers | Test with the providers customers use. |
| Encryption of sensitive data | Sensitive values are encrypted in the application with AES-256-GCM, using a separate key for each company. Browser connections use HTTPS. | Field encryption implemented; storage-level encryption depends on the hosting plan. Production backfill status of existing data UNCONFIRMED | Confirm the encryption key is set and backed up outside the host; run backfill after a backup; confirm database disk encryption on the chosen plan. |
| Audit trail | Changes are recorded with who, what and when, and the audit records cannot be edited through the product. | Implemented (append-only) | Define retention. |
| API keys and webhooks | API keys are read-only, scoped, stored hashed, shown once and revocable, and expose no pay, bank, identity or contact data. Webhooks keep a delivery history. | Implemented | None. |
| Application hardening | Standard HTTP security headers and request rate limits are applied by the application, and this website sends strict security headers. | Implemented | Re-run header and dependency checks before launch. |
| Data-subject requests | A workflow to receive and handle requests about personal data. | Implemented | Document the internal procedure. |
| Backups and restore | Backup, restore and recovery arrangements are agreed in writing for each customer before go-live. | NOT IN PLACE: the current database plan has no automated backups (a manual snapshot script exists) | BLOCKER: move to a plan with backups and test a restore before any real payroll data is loaded. Then confirm the public wording. |
| Disaster recovery | Recovery arrangements form part of the written hosting agreement for each customer. | NOT DEFINED | BLOCKER: write a recovery plan, set targets, test it. Only then keep or change the wording. |
| Hosting | AiHxM runs on managed cloud services. The hosting arrangement for a customer's production data is confirmed in writing before go-live. Dedicated hosting is available as a scoped service. | Cloud services in use; production plan is a free tier that sleeps when idle | BLOCKER: move the API to a paid plan in a suitable region before customers. |
| Data location | Where a customer's data is stored is stated in writing before contract. If your policy requires a specific country, tell us first. | Database hosted outside Pakistan (Sydney, per the earlier infrastructure review: reconfirm). No Pakistan-hosted option | Decide a data-location policy; confirm with legal; prepare a dedicated-hosting offer if needed. |
| Incident response | Incident handling and customer notification terms are set out in the customer agreement. | NO PROCEDURE | Write and rehearse an incident-response procedure and customer-notification terms. |
| Reporting a vulnerability | Security concerns can be reported through the contact page and are reviewed by the team. | No programme; contact form only | Add a security contact and handling process. |
| Service providers | The third-party services that process customer data are listed in writing during procurement. | NO LIST | Compile the list of service providers that process customer data (hosting, database, mail, storage). |
| Independent testing and assurance | Questions about independent testing or assurance reports are answered in writing during procurement. | NONE HELD: no penetration test, no certification | Decide whether to commission an independent test; the website must not claim any certification until one exists. |

## Known gaps removed from public wording

These limitations used to be stated on the public pages. They are no longer shown there, so they are recorded here and must be closed or scoped before launch.

| Area | Gap | Close by |
| --- | --- | --- |
| Performance | No 360-degree feedback; reviews are self and manager assessments with calibration. | Build, or keep the page wording to what exists. |
| Learning | No certificate expiry tracking. | Build. |
| Expenses | Expense categories are free text; no per-category limits or mileage rules. | Build category policy. |
| Offboarding | Clearance is a checklist; no multi-step, multi-department chain. | Build. |
| HR Help Desk | No automatic escalation or full service-level rules; clocks and ageing only. | Build. |
| Self-service | No native app-store apps; Urdu is partial. | Decide scope; finish Urdu. |
| Payroll | No payroll register by department or cost centre; no scheduled or auto-prepared payroll run. | Build. |
| Payroll reports | No FBR upload, annual statement or challan layout; EOBI wage base needs confirmation. | Decide scope with an accountant. |
| Banking | No ready-made bank-specific layouts; only a company-defined generic layout. | Build for target banks. |
| Notifications | WhatsApp and push are recorded but not sent (no provider connected). | Select a provider and build. |
| Configuration | The form designer lays out the employee form; other forms only allow field settings. | Extend or describe accurately. |

## Other public claims to verify

| Page or claim | Real state | Action before launch |
| --- | --- | --- |
| Pricing page, scope estimator | No approved prices. The estimator shows a scope only. Price arithmetic is built and unit-tested but switched off. | Approve prices, fill `approvedPrices` in `commercial.mjs`, set `pricingPublished`. |
| Support tiers | Names and coverage are proposals. No channels, hours or response targets exist. | Approve and staff them; fill the tier fields; set `supportApproved`. |
| Hosting options (standard / dedicated) | Dedicated hosting has no offering, price or runbook. | Define it or remove it. |
| Public playground | A browser-only simulation on fictional data. No server, no storage. Tax bands are invented. | Keep the sample-data labels; never use real figures. |
| Case studies | None. The case-study architecture exists and publishes only entries with a recorded customer approval. | Add entries only with written customer approval. |
| Company details, founder | Not set. The site shows only what the environment variables supply. | Set legal name, registration number, address, founder name and role. |
| Privacy Policy and Terms | Templates; not reviewed by a lawyer. | Legal review, then set the reviewed flags. |
| Urdu interface | Switcher exists on main screens; many pages are English. | Complete or describe accurately. |
| Mobile app | Installable web app only; no store apps. | Public wording already says installable on Android and iPhone; keep it so. |
| Intelligent HR page | Forward-looking description. Only a rules-based keyword assistant and data checks exist; no AI or model is built. | Build, or keep the page as a clearly future-facing vision; never state AI results. |
| Contact email | Not set. | Set a monitored address before launch. |

## Totals

| Status | Capabilities |
| --- | --- |
| Available | 219 |
| Configurable | 3 |
| Requires external integration | 2 |
| Partially available | 10 |
| In development | 0 |
| Planned | 31 |
| **All advertised module capabilities** | **265** |

## Pre-launch gate: claims versus reality

Before commercial launch, compare every public claim with production. Each row below is advertised (or implied) today but is not yet deliverable as described. For each: **build it, remove it from the website, or scope it explicitly in the contract** before a customer is asked to buy.

| Where | Item | Why it is a gate item | What closes it |
| --- | --- | --- | --- |
| Attendance & Time | Biometric Punch Intake | Requires external integration | Compatibility testing with the device vendors customers use; device setup guide. |
| Attendance & Time | Device Punch Intake | Requires external integration | Compatibility testing with real devices; device-key rotation runbook. |
| Payroll | Payment Batches | Partially available | Ready-made bank file layouts for the banks customers use; decide on instant-payment scheme support; test files with each bank. |
| Onboarding & Offboarding | Clearance Management | Partially available | Multi-step, multi-department clearance chains (today a checklist). |
| Benefits Management | Benefit Plans | Partially available | Finish the missing behaviour (see module notes), then test. |
| Benefits Management | Eligibility Rules | Planned | Design, build, test, document. |
| Benefits Management | Employee Groups and Grades | Partially available | Finish the missing behaviour (see module notes), then test. |
| Benefits Management | Employee Enrolment | Partially available | Finish the missing behaviour (see module notes), then test. |
| Benefits Management | Open Enrolment Windows | Planned | Design, build, test, document. |
| Benefits Management | Dependents and Beneficiaries | Planned | Design, build, test, document. |
| Benefits Management | Life Event Changes | Planned | Design, build, test, document. |
| Benefits Management | Employer and Employee Contributions | Partially available | Finish the missing behaviour (see module notes), then test. |
| Benefits Management | Payroll Deductions | Partially available | Finish the missing behaviour (see module notes), then test. |
| Benefits Management | Benefits Cost Reports | Planned | Design, build, test, document. |
| Benefits Management | Employee Benefit Statements | Planned | Design, build, test, document. |
| Shift Management | Roster Planning | Planned | Design, build, test, document. |
| Shift Management | Shift Swap Requests | Planned | Design, build, test, document. |
| Shift Management | Shift Coverage Reports | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Headcount and Movement Trends | Partially available | Finish the missing behaviour (see module notes), then test. |
| Advanced Workforce Analytics | Turnover Analysis | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Span of Control and Hierarchy | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Absence and Attendance Trends | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Overtime and Labour Cost Analysis | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Payroll Cost by Department and Location | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Role-Based Dashboards | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Scheduled Report Delivery | Planned | Design, build, test, document. |
| Advanced Workforce Analytics | Drill-Down from Dashboard to Record | Planned | Design, build, test, document. |
| Intelligent HR | Self-Service HR Assistant | Partially available | Finish the missing behaviour (see module notes), then test. |
| Intelligent HR | Policy Question Answering | Planned | Design, build, test, document. |
| Intelligent HR | Natural-Language Report Search | Planned | Design, build, test, document. |
| Intelligent HR | Smart Data Checks | Partially available | Finish the missing behaviour (see module notes), then test. |
| Intelligent HR | Payroll Anomaly Review | Planned | Design, build, test, document. |
| Intelligent HR | Duplicate and Inconsistency Detection | Planned | Design, build, test, document. |
| Intelligent HR | Attrition Risk Indicators | Planned | Design, build, test, document. |
| Intelligent HR | Workforce Forecasting | Planned | Design, build, test, document. |
| Intelligent HR | Skills Gap Insight | Planned | Design, build, test, document. |
| Business Travel | Itineraries | Planned | Design, build, test, document. |
| Business Travel | Travel Policy Rules | Planned | Design, build, test, document. |
| Business Travel | Per-Diem and Allowance Rules | Planned | Design, build, test, document. |
| Business Travel | Travel Reports | Planned | Design, build, test, document. |
| Announcements | Scheduled Posts | Planned | Design, build, test, document. |
| Announcements | Read Tracking | Planned | Design, build, test, document. |
| Announcements | Pinned Announcements | Planned | Design, build, test, document. |
| Integrations | Payment batches with a company-defined bank file | Partially available | Finish the missing behaviour (see module notes), then test. |
| Integrations | Bank file layouts | Planned | Design, build, test, document. |
| Integrations | Device punch intake | Requires external integration | Integration specification, compatibility test with real devices or providers, setup guide. |
| Integrations | Biometric devices | Requires external integration | Integration specification, compatibility test with real devices or providers, setup guide. |
| Integrations | Direct connection to accounting software | Planned | Design, build, test, document. |
| Integrations | Email notifications | Requires external integration | Integration specification, compatibility test with real devices or providers, setup guide. |
| Integrations | Mobile push and messaging notifications | Planned | Design, build, test, document. |
| Security and trust | Backups and restore | Wording ahead of reality | BLOCKER: move to a plan with backups and test a restore before any real payroll data is loaded. Then confirm the public wording. |
| Security and trust | Disaster recovery | Wording ahead of reality | BLOCKER: write a recovery plan, set targets, test it. Only then keep or change the wording. |
| Security and trust | Hosting | Wording ahead of reality | BLOCKER: move the API to a paid plan in a suitable region before customers. |
| Security and trust | Incident response | Wording ahead of reality | Write and rehearse an incident-response procedure and customer-notification terms. |
| Security and trust | Service providers | Wording ahead of reality | Compile the list of service providers that process customer data (hosting, database, mail, storage). |
| Security and trust | Independent testing and assurance | Wording ahead of reality | Decide whether to commission an independent test; the website must not claim any certification until one exists. |

56 gate items.

## Review log

- 2026-10-30: first full register generated for the product-vision website (SITE2).
