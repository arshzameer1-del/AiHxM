import type { PoolClient } from "pg";

/**
 * PAY-20 - when a tenant requires publication, an employee sees their own payslip only once a payslip document for it
 * has been issued and published. Returns the ids (of those asked about) that must stay hidden from the employee.
 * With the setting off (the default) nothing is hidden, which is the behaviour before PAY-20.
 */
export async function payslipsHiddenFromSelf(client: PoolClient, payslipIds: string[]): Promise<Set<string>> {
  if (payslipIds.length === 0) return new Set();
  const s = await client.query("SELECT require_publication FROM payroll_document_settings LIMIT 1");
  if (!s.rows[0]?.require_publication) return new Set();
  const shown = await client.query(
    "SELECT payslip_id FROM generated_documents WHERE payslip_id = ANY($1::uuid[]) AND document_type = 'payslip' AND status = 'issued' AND published_at IS NOT NULL",
    [payslipIds]
  );
  const visible = new Set(shown.rows.map((r) => r.payslip_id as string));
  return new Set(payslipIds.filter((id) => !visible.has(id)));
}
