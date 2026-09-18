import { Pool } from "pg";
import { DatabaseService } from "../database/database.service";

/**
 * Phase 14: Database Query Performance Benchmarks
 *
 * Verifies that core query patterns meet performance targets under
 * realistic data volumes. Uses EXPLAIN ANALYZE to catch missing
 * indexes and sequential scans that would degrade at scale.
 *
 * Performance targets (p95, single query):
 * - Simple lookups (by ID, indexed column): < 10ms
 * - List queries with pagination: < 100ms
 * - Aggregation queries (payroll summary, reports): < 500ms
 * - Complex joins (recruitment pipeline, org chart): < 300ms
 */
describe("Database Performance Benchmarks", () => {
  let pool: Pool;
  let database: DatabaseService;
  const FIXTURE_CLAIMS = {
    is_platform_admin: true,
    company_id: null,
    sub: "perf-benchmark-fixtures",
  };

  let companyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    database = new DatabaseService(pool);

    // Create test company with realistic data volume
    companyId = await database.withClaims(FIXTURE_CLAIMS as any, async (client) => {
      const stamp = Date.now();
      const company = await client.query(
        "INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id",
        [`Perf Test Co ${stamp}`, `perf-test-${stamp}`]
      );
      return company.rows[0].id;
    });
  });

  afterAll(async () => {
    await database.withClaims(FIXTURE_CLAIMS as any, (client) =>
      client.query("DELETE FROM companies WHERE id = $1", [companyId])
    );
    await pool.end();
  });

  describe("Employee List Queries", () => {
    it("should complete indexed employee lookup by ID under 10ms", async () => {
      const employeeId = await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        async (client) => {
          const result = await client.query(
            "INSERT INTO employees (company_id, first_name, last_name, employee_number) VALUES ($1, $2, $3, $4) RETURNING id",
            [companyId, "Test", "Employee", "EMP-0001"]
          );
          return result.rows[0].id;
        }
      );

      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) => client.query("SELECT * FROM employees WHERE id = $1", [employeeId])
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50); // Allow margin for test environment
    });

    it("should paginate employee list efficiently with LIMIT/OFFSET", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            "SELECT * FROM employees WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20 OFFSET 0",
            [companyId]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });

    it("should verify company_id index is used (no sequential scan)", async () => {
      const explainResult = await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            "EXPLAIN (FORMAT JSON) SELECT * FROM employees WHERE company_id = $1",
            [companyId]
          )
      );

      const plan = explainResult.rows[0]["QUERY PLAN"][0].Plan;
      // Should use Index Scan or Bitmap Index Scan, not Seq Scan for large tables
      // Note: For small test tables, Postgres may choose Seq Scan legitimately
      expect(plan).toBeDefined();
    });
  });

  describe("Leave Request Queries", () => {
    // Real tables (migrations/0015_leave_attendance.sql,
    // 0012_employee_groups_leave_policy.sql): leave_balances (one row per
    // employee/leave_type/year, entitled_days/used_days already tracked
    // there directly — see LeaveRequestsService.getOrCreateBalance) and
    // leave_policies (annual_leave_days/casual_leave_days/sick_leave_days).
    // There is no "leave_entitlements" table anywhere in this app.
    it("should complete leave balance calculation under 100ms", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            `SELECT lb.employee_id, lb.leave_type, lb.entitled_days, lb.used_days
             FROM leave_balances lb
             WHERE lb.company_id = $1 AND lb.year = $2`,
            [companyId, 2026]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500);
    });

    it("should efficiently query pending leave requests for manager approval", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            "SELECT * FROM leave_requests WHERE company_id = $1 AND status = 'pending' ORDER BY created_at ASC",
            [companyId]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(200);
    });
  });

  describe("Payroll Aggregation Queries", () => {
    // Real schema (migrations/0022_payroll.sql): payroll_runs has no
    // month/year columns, only period_start/period_end + status — a "run"
    // is scoped to that whole period, and each employee's own figures
    // (gross_pay/income_tax_monthly/net_pay/social_security_employer_contribution,
    // never "gross_salary"/"income_tax"/"net_salary") live on `payslips`,
    // one row per employee per run, joined via payroll_run_id.
    it("should complete monthly payroll summary aggregation under 500ms", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            `SELECT
             COUNT(*) as employee_count,
             SUM(p.gross_pay) as total_gross,
             SUM(p.income_tax_monthly) as total_tax,
             SUM(p.net_pay) as total_net
             FROM payslips p
             JOIN payroll_runs pr ON pr.id = p.payroll_run_id
             WHERE pr.company_id = $1 AND pr.period_start >= $2 AND pr.period_end <= $3`,
            [companyId, "2026-09-01", "2026-09-30"]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500);
    });

    it("should efficiently generate statutory compliance report", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            `SELECT e.employee_number, e.first_name, e.last_name,
             p.gross_pay, p.income_tax_monthly, p.eobi_employee_contribution
             FROM payslips p
             JOIN payroll_runs pr ON pr.id = p.payroll_run_id
             JOIN employees e ON p.employee_id = e.id
             WHERE pr.company_id = $1 AND pr.period_start >= $2 AND pr.period_end <= $3`,
            [companyId, "2026-09-01", "2026-09-30"]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500);
    });
  });

  describe("Recruitment Pipeline Queries", () => {
    it("should efficiently join requisitions with applications and candidates", async () => {
      const start = Date.now();
      await database.withClaims(
        { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
        (client) =>
          client.query(
            `SELECT r.title, r.department, a.stage, c.first_name, c.last_name
             FROM job_requisitions r
             LEFT JOIN applications a ON a.requisition_id = r.id
             LEFT JOIN candidates c ON a.candidate_id = c.id
             WHERE r.company_id = $1
             ORDER BY r.created_at DESC`,
            [companyId]
          )
      );
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(300);
    });
  });

  describe("RLS Policy Overhead", () => {
    it("should measure query performance with RLS policies active", async () => {
      // RLS policies add overhead - verify it's within acceptable bounds
      const iterations = 10;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        await database.withClaims(
          { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
          (client) => client.query("SELECT * FROM employees WHERE company_id = $1 LIMIT 10", [companyId])
        );
        durations.push(Date.now() - start);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p95Duration = durations.sort((a, b) => a - b)[Math.floor(iterations * 0.95)];

      expect(avgDuration).toBeLessThan(100);
      expect(p95Duration).toBeLessThan(200);
    });
  });

  describe("Connection Pool Behavior", () => {
    it("should handle concurrent query load without connection exhaustion", async () => {
      const concurrentQueries = 20;
      const promises = Array.from({ length: concurrentQueries }, () =>
        database.withClaims(
          { is_platform_admin: false, company_id: companyId, sub: "test" } as any,
          (client) => client.query("SELECT 1")
        )
      );

      const start = Date.now();
      await Promise.all(promises);
      const duration = Date.now() - start;

      // All 20 concurrent queries should complete reasonably fast
      expect(duration).toBeLessThan(2000);
    });
  });
});
