import { Pool } from "pg";
import { hashPassword } from "../auth/password";

async function main() {
  const pool = new Pool({ connectionString: "postgresql://aihxm:aihxm_dev@localhost:5432/aihxm" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claims', '{\"is_service\": true}', true)");

    const existing = await client.query("SELECT id FROM companies WHERE slug = 'kumail-test-co'");
    let companyId: string;
    if ((existing.rowCount ?? 0) > 0) {
      companyId = existing.rows[0].id;
      console.log("Reusing company", companyId);
    } else {
      const company = await client.query(
        `INSERT INTO companies (name, slug, package_tier, status) VALUES ($1,$2,$3,$4) RETURNING id`,
        ["Kumail Test Co", "kumail-test-co", "professional", "active"]
      );
      companyId = company.rows[0].id;
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","leave","recruitment","performance","payroll"]'::jsonb,
                 '{"prefix":"KTC","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );
      console.log("Created company", companyId);
    }

    for (const m of ["employee", "leave", "recruitment", "performance", "payroll"]) {
      await client.query(
        `INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,$2,true)
         ON CONFLICT (company_id, module_key) DO UPDATE SET enabled = true`,
        [companyId, m]
      );
    }

    const email = "kumail-ui-test@example.com";
    const passwordHash = await hashPassword("TestPass123!");
    let userId: string;
    const existingUser = await client.query("SELECT id FROM user_accounts WHERE email = $1", [email]);
    if ((existingUser.rowCount ?? 0) > 0) {
      userId = existingUser.rows[0].id;
      await client.query("UPDATE user_accounts SET password_hash = $1, mfa_enrolled_at = now(), mfa_secret_encrypted = mfa_secret_encrypted WHERE id = $2", [passwordHash, userId]);
    } else {
      const user = await client.query(
        "INSERT INTO user_accounts (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, passwordHash]
      );
      userId = user.rows[0].id;
    }
    console.log("User", userId, email);

    const role = await client.query("SELECT id FROM roles WHERE key = 'hr_admin'");
    if ((role.rowCount ?? 0) === 0) throw new Error("hr_admin role not found");
    const existingAssign = await client.query(
      "SELECT 1 FROM user_role_assignments WHERE user_account_id = $1 AND company_id = $2 AND role_id = $3",
      [userId, companyId, role.rows[0].id]
    );
    if ((existingAssign.rowCount ?? 0) === 0) {
      await client.query(
        "INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,$3)",
        [userId, companyId, role.rows[0].id]
      );
    }

    const emp = await client.query("SELECT id FROM employees WHERE company_id = $1 AND user_account_id = $2", [companyId, userId]);
    if ((emp.rowCount ?? 0) === 0) {
      await client.query(
        `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1,$2,'KTC-0001','Kumail','Test','2024-01-01')`,
        [companyId, userId]
      );
      console.log("Employee created");
    }

    await client.query("COMMIT");
    console.log("DONE. companyId=", companyId, "email=", email, "password=TestPass123!");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
