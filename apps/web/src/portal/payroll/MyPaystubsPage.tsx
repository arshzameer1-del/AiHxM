import { PageHeader } from "../shared/PageChrome";
import { MyPaystubsTable } from "./MyPaystubsTable";
import { MyPayrollDocumentsCard } from "./PayrollDocumentsPanels";

/**
 * My Paystubs (Employee Self Service). Always the signed-in person's own paystubs, whatever their role: an HR Admin or a
 * payroll approver opening this tile sees their own pay, not the company's. Everybody else's payslips are in the Payroll
 * page (Run payroll tab), under the payroll run they belong to.
 */
export function MyPaystubsPage() {
  return (
    <div>
      <PageHeader title="My Paystubs" subtitle="Your own paystubs appear here once a payroll run has been finalized." />
      <MyPaystubsTable />
      <MyPayrollDocumentsCard />
    </div>
  );
}
