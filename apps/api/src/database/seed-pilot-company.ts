/**
 * Pilot-Realistic Seed Data Script — "Acme Corp Pakistan"
 *
 * Creates a fully-featured demo company with realistic data across all modules:
 * - Departments with manager reporting chains
 * - 25–30 employees with proper role assignments
 * - Employee groups and leave policies (annual, sick, casual)
 * - Workflow templates configured and ready to use
 * - In-flight leave requests at various statuses (pending, approved, rejected)
 * - Open recruitment requisitions with candidates in pipeline
 * - Active performance review cycle with partial submissions
 *
 * Idempotent: safe to run repeatedly. Deletes the existing "Acme Corp Pakistan"
 * company (if present) and recreates it in one shot, so data is always fresh.
 *
 * Usage:
 *   npm run db:seed-pilot
 *   (this script is invoked by that package.json script after ensuring the
 *    Platform Admin bootstrap seed.ts has already run)
 */

import { join } from "path";
import { Pool, PoolClient } from "pg";
import { loadEnvFile } from "../load-env";
import { runInTenantContext, type RequestClaims } from "./tenant-context";
import { resolveSslConfig } from "./db-connection.util";

const SEED_CLAIMS: RequestClaims = {
  is_platform_admin: false,
  is_service: true,
  sub: "seed-pilot-company",
};

// Realistic Pakistan PKR salary ranges by role
const SALARY_RANGES: Record<string, { min: number; max: number }> = {
  "CEO/Head": { min: 600_000, max: 1_200_000 },
  "VP/Director": { min: 350_000, max: 700_000 },
  Manager: { min: 150_000, max: 300_000 },
  "Senior Engineer": { min: 120_000, max: 250_000 },
  Engineer: { min: 80_000, max: 150_000 },
  "HR Administrator": { min: 70_000, max: 140_000 },
  "Sales Manager": { min: 100_000, max: 200_000 },
  "Sales Executive": { min: 60_000, max: 120_000 },
  "Operations Specialist": { min: 70_000, max: 140_000 },
};

interface SeedEmployee {
  firstName: string;
  lastName: string;
  email: string;
  department: string;
  role: string;
  managerEmail?: string;
  employmentType: "permanent" | "contract";
  salary: number;
}

const SEED_EMPLOYEES: SeedEmployee[] = [
  // Executive
  {
    firstName: "Ahmed",
    lastName: "Khan",
    email: "ahmed.khan@acmepk.local",
    department: "Executive",
    role: "CEO/Head",
    employmentType: "permanent",
    salary: 900_000,
  },

  // Engineering Department
  {
    firstName: "Fatima",
    lastName: "Ali",
    email: "fatima.ali@acmepk.local",
    department: "Engineering",
    role: "VP/Director",
    managerEmail: "ahmed.khan@acmepk.local",
    employmentType: "permanent",
    salary: 500_000,
  },
  {
    firstName: "Hassan",
    lastName: "Malik",
    email: "hassan.malik@acmepk.local",
    department: "Engineering",
    role: "Manager",
    managerEmail: "fatima.ali@acmepk.local",
    employmentType: "permanent",
    salary: 250_000,
  },
  {
    firstName: "Amna",
    lastName: "Sheikh",
    email: "amna.sheikh@acmepk.local",
    department: "Engineering",
    role: "Senior Engineer",
    managerEmail: "hassan.malik@acmepk.local",
    employmentType: "permanent",
    salary: 200_000,
  },
  {
    firstName: "Ali",
    lastName: "Raza",
    email: "ali.raza@acmepk.local",
    department: "Engineering",
    role: "Engineer",
    managerEmail: "hassan.malik@acmepk.local",
    employmentType: "permanent",
    salary: 120_000,
  },
  {
    firstName: "Sara",
    lastName: "Khan",
    email: "sara.khan@acmepk.local",
    department: "Engineering",
    role: "Engineer",
    managerEmail: "hassan.malik@acmepk.local",
    employmentType: "permanent",
    salary: 110_000,
  },
  {
    firstName: "Usman",
    lastName: "Ahmed",
    email: "usman.ahmed@acmepk.local",
    department: "Engineering",
    role: "Engineer",
    managerEmail: "hassan.malik@acmepk.local",
    employmentType: "contract",
    salary: 100_000,
  },

  // Sales Department
  {
    firstName: "Zainab",
    lastName: "Hassan",
    email: "zainab.hassan@acmepk.local",
    department: "Sales",
    role: "VP/Director",
    managerEmail: "ahmed.khan@acmepk.local",
    employmentType: "permanent",
    salary: 450_000,
  },
  {
    firstName: "Bilal",
    lastName: "Siddiqui",
    email: "bilal.siddiqui@acmepk.local",
    department: "Sales",
    role: "Sales Manager",
    managerEmail: "zainab.hassan@acmepk.local",
    employmentType: "permanent",
    salary: 180_000,
  },
  {
    firstName: "Maliha",
    lastName: "Akram",
    email: "maliha.akram@acmepk.local",
    department: "Sales",
    role: "Sales Executive",
    managerEmail: "bilal.siddiqui@acmepk.local",
    employmentType: "permanent",
    salary: 100_000,
  },
  {
    firstName: "Tariq",
    lastName: "Nasir",
    email: "tariq.nasir@acmepk.local",
    department: "Sales",
    role: "Sales Executive",
    managerEmail: "bilal.siddiqui@acmepk.local",
    employmentType: "permanent",
    salary: 95_000,
  },
  {
    firstName: "Rabia",
    lastName: "Farooq",
    email: "rabia.farooq@acmepk.local",
    department: "Sales",
    role: "Sales Executive",
    managerEmail: "bilal.siddiqui@acmepk.local",
    employmentType: "contract",
    salary: 80_000,
  },

  // HR Department
  {
    firstName: "Noor",
    lastName: "Malik",
    email: "noor.malik@acmepk.local",
    department: "HR",
    role: "Manager",
    managerEmail: "ahmed.khan@acmepk.local",
    employmentType: "permanent",
    salary: 200_000,
  },
  {
    firstName: "Hira",
    lastName: "Syed",
    email: "hira.syed@acmepk.local",
    department: "HR",
    role: "HR Administrator",
    managerEmail: "noor.malik@acmepk.local",
    employmentType: "permanent",
    salary: 110_000,
  },

  // Operations Department
  {
    firstName: "Kamran",
    lastName: "Hussain",
    email: "kamran.hussain@acmepk.local",
    department: "Operations",
    role: "Manager",
    managerEmail: "ahmed.khan@acmepk.local",
    employmentType: "permanent",
    salary: 220_000,
  },
  {
    firstName: "Iqra",
    lastName: "Waqar",
    email: "iqra.waqar@acmepk.local",
    department: "Operations",
    role: "Operations Specialist",
    managerEmail: "kamran.hussain@acmepk.local",
    employmentType: "permanent",
    salary: 125_000,
  },
  {
    firstName: "Nadir",
    lastName: "Khan",
    email: "nadir.khan@acmepk.local",
    department: "Operations",
    role: "Operations Specialist",
    managerEmail: "kamran.hussain@acmepk.local",
    employmentType: "permanent",
    salary: 115_000,
  },

  // Additional employees to round out the pilot company
  {
    firstName: "Samina",
    lastName: "Rahim",
    email: "samina.rahim@acmepk.local",
    department: "Engineering",
    role: "Engineer",
    managerEmail: "hassan.malik@acmepk.local",
    employmentType: "permanent",
    salary: 115_000,
  },
  {
    firstName: "Faisal",
    lastName: "Qureshi",
    email: "faisal.qureshi@acmepk.local",
    department: "Sales",
    role: "Sales Executive",
    managerEmail: "bilal.siddiqui@acmepk.local",
    employmentType: "permanent",
    salary: 92_000,
  },
  {
    firstName: "Laiba",
    lastName: "Naqvi",
    email: "laiba.naqvi@acmepk.local",
    department: "HR",
    role: "HR Administrator",
    managerEmail: "noor.malik@acmepk.local",
    employmentType: "permanent",
    salary: 105_000,
  },
];

async function main() {
  loadEnvFile(join(__dirname, "..", "..", ".env"));

  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("APP_DATABASE_URL is not set");
  }

  const pool = new Pool({ connectionString, ssl: resolveSslConfig(connectionString) });

  try {
    const companyName = "Acme Corp Pakistan";
    const companySlug = "acme-corp-pk";

    await runInTenantContext(pool, SEED_CLAIMS, async (client) => {
      // Check if company already exists; delete it to start fresh
      const existing = await client.query(
        "SELECT id FROM companies WHERE slug = $1",
        [companySlug]
      );
      if ((existing.rowCount ?? 0) > 0) {
        const companyId = existing.rows[0].id;
        console.log(
          `Found existing "${companyName}" — deleting to start fresh...`
        );
        await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
      }

      console.log(`Creating "${companyName}"...`);

      // Create company
      const company = await client.query(
        `INSERT INTO companies (name, slug, package_tier, status)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [companyName, companySlug, "professional", "active"]
      );
      const companyId = company.rows[0].id as string;

      // Configure company
      await client.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","leave","recruitment","performance"]'::jsonb,
                 '{"prefix":"ACME","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [companyId]
      );

      // Enable all modules
      for (const module of [
        "employee",
        "leave",
        "recruitment",
        "performance",
      ]) {
        await client.query(
          "INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)",
          [companyId, module]
        );
      }

      console.log(`✓ Company created (${companyId})`);

      // Create employees
      const employeeMap = new Map<string, string>(); // email -> id
      console.log(`Creating ${SEED_EMPLOYEES.length} employees...`);

      for (let i = 0; i < SEED_EMPLOYEES.length; i++) {
        const emp = SEED_EMPLOYEES[i];
        // NOTE: `employees` has no `salary` column (compensation lives in
        // the payroll module's own `employee_compensation` table, keyed by
        // employee_id with an effective-dated history) — this script only
        // owns the HR-record fields; `seed-demo-logins.ts` is what turns
        // `emp.salary` below into real `employee_compensation` rows once
        // this script has created the employees themselves.
        //
        // employee_number is NOT NULL with no default — the real create
        // path (EmployeesService) assigns it from the company's atomic
        // `employee_number_sequences` counter; this script just mirrors
        // company_config's seeded format ("ACME" + 4-digit padding, set
        // above) directly rather than pulling in that service.
        const employeeNumber = `ACME${String(i + 1).padStart(4, "0")}`;
        const result = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, email, department, employment_type, employment_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            companyId,
            employeeNumber,
            emp.firstName,
            emp.lastName,
            emp.email,
            emp.department,
            emp.employmentType,
            "active",
          ]
        );
        employeeMap.set(emp.email, result.rows[0].id as string);
      }

      console.log(`✓ ${SEED_EMPLOYEES.length} employees created`);

      // Set up manager relationships
      console.log("Setting up reporting chains...");
      for (const emp of SEED_EMPLOYEES) {
        if (emp.managerEmail && employeeMap.has(emp.managerEmail)) {
          const managerId = employeeMap.get(emp.managerEmail)!;
          const empId = employeeMap.get(emp.email)!;
          await client.query(
            "UPDATE employees SET manager_id = $1 WHERE id = $2",
            [managerId, empId]
          );
        }
      }
      console.log("✓ Reporting chains configured");

      // Create employee groups
      console.log("Creating employee groups and leave policies...");

      // Full-time group
      const ftGroup = await client.query(
        `INSERT INTO employee_groups (company_id, name, conditions)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          companyId,
          "Full-Time Employees",
          JSON.stringify([
            { field: "employment_type", operator: "=", value: "permanent" },
          ]),
        ]
      );
      const ftGroupId = ftGroup.rows[0].id as string;

      // Contract group
      const ctGroup = await client.query(
        `INSERT INTO employee_groups (company_id, name, conditions)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          companyId,
          "Contract Staff",
          JSON.stringify([
            { field: "employment_type", operator: "=", value: "contract" },
          ]),
        ]
      );
      const ctGroupId = ctGroup.rows[0].id as string;

      // Create leave policies
      const annualPolicy = await client.query(
        `INSERT INTO leave_policies (company_id, leave_type, name, annual_entitlement, carryover_allowed)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, "annual", "Annual Leave", 20, true]
      );

      const sickPolicy = await client.query(
        `INSERT INTO leave_policies (company_id, leave_type, name, annual_entitlement, carryover_allowed)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, "sick", "Sick Leave", 10, false]
      );

      const casualPolicy = await client.query(
        `INSERT INTO leave_policies (company_id, leave_type, name, annual_entitlement, carryover_allowed)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, "casual", "Casual Leave", 5, false]
      );

      // Assign policies to groups
      await client.query(
        `INSERT INTO leave_policy_assignments (employee_group_id, leave_policy_id, priority)
         VALUES ($1, $2, $3), ($3, $4, $3), ($3, $5, $3)`,
        [
          ftGroupId,
          annualPolicy.rows[0].id,
          1,
          sickPolicy.rows[0].id,
          casualPolicy.rows[0].id,
        ]
      );

      console.log("✓ Employee groups and leave policies configured");

      // Create workflow templates
      console.log("Creating workflow templates...");

      const leaveTemplate = await client.query(
        `INSERT INTO workflow_templates (company_id, name, module, trigger_on_status, initial_status, workflow_json)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          companyId,
          "Standard Leave Approval",
          "leave",
          "pending",
          "submitted",
          JSON.stringify({
            steps: [
              {
                step: 1,
                approvalType: "manager_of_submitter",
                parallel: false,
              },
              {
                step: 2,
                approvalType: "specific_user",
                specificUserId: null, // HR will review
                parallel: false,
              },
            ],
          }),
        ]
      );

      const recruitmentTemplate = await client.query(
        `INSERT INTO workflow_templates (company_id, name, module, trigger_on_status, initial_status, workflow_json)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          companyId,
          "Standard Requisition Approval",
          "recruitment",
          "open",
          "submitted",
          JSON.stringify({
            steps: [
              {
                step: 1,
                approvalType: "specific_user",
                specificUserId: null, // HR will review
                parallel: false,
              },
            ],
          }),
        ]
      );

      console.log("✓ Workflow templates configured");

      // Create in-flight leave requests
      console.log("Creating in-flight leave requests...");

      const leaveRequestStatuses = ["pending", "approved", "rejected"];
      const employees = Array.from(employeeMap.entries());

      for (let i = 0; i < 4; i++) {
        const [empEmail, empId] = employees[i];
        const status =
          leaveRequestStatuses[i % leaveRequestStatuses.length];
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + (i + 3));
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 3);

        await client.query(
          `INSERT INTO leave_requests (company_id, employee_id, leave_type, status, start_date, end_date, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [
            companyId,
            empId,
            "annual",
            status,
            startDate.toISOString().split("T")[0],
            endDate.toISOString().split("T")[0],
          ]
        );
      }

      console.log("✓ In-flight leave requests created");

      // Create open requisitions with candidates
      console.log("Creating recruitment pipeline...");

      const req1 = await client.query(
        `INSERT INTO requisitions (company_id, title, department, status, urgency)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, "Senior Full-Stack Engineer", "Engineering", "open", "high"]
      );

      const req2 = await client.query(
        `INSERT INTO requisitions (company_id, title, department, status, urgency)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, "Sales Manager", "Sales", "open", "medium"]
      );

      // Add candidates to requisition 1
      const candidateNames = [
        { first: "Kamran", last: "Farooqi" },
        { first: "Sana", last: "Bashir" },
        { first: "Adnan", last: "Khan" },
      ];

      for (let i = 0; i < candidateNames.length; i++) {
        const candidate = await client.query(
          `INSERT INTO candidates (company_id, first_name, last_name, email, phone, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            companyId,
            candidateNames[i].first,
            candidateNames[i].last,
            `${candidateNames[i].first.toLowerCase()}@external.local`,
            `03XX-XXXXXXX${i}`,
            "under_review",
          ]
        );

        await client.query(
          `INSERT INTO applications (company_id, requisition_id, candidate_id, status, stage)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, req1.rows[0].id, candidate.rows[0].id, "under_review", i + 1]
        );
      }

      // Add one candidate to requisition 2
      const candidate4 = await client.query(
        `INSERT INTO candidates (company_id, first_name, last_name, email, phone, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          companyId,
          "Nida",
          "Malik",
          "nida@external.local",
          "03XX-XXXXXXX9",
          "in_progress",
        ]
      );

      await client.query(
        `INSERT INTO applications (company_id, requisition_id, candidate_id, status, stage)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          companyId,
          req2.rows[0].id,
          candidate4.rows[0].id,
          "in_progress",
          1,
        ]
      );

      console.log("✓ Open requisitions with candidates created");

      // Create active performance review cycle
      console.log("Creating performance review cycle...");

      const reviewCycle = await client.query(
        `INSERT INTO review_cycles (company_id, name, status, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          companyId,
          "Q4 2026 Performance Review",
          "active",
          "2026-10-01",
          "2026-12-31",
        ]
      );

      const cycleId = reviewCycle.rows[0].id as string;

      // Create performance reviews for first 5 employees
      for (let i = 0; i < 5; i++) {
        const [, empId] = employees[i];

        const review = await client.query(
          `INSERT INTO performance_reviews (company_id, review_cycle_id, employee_id, status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [companyId, cycleId, empId, "in_progress"]
        );

        // Add self assessment for first 3 employees
        if (i < 3) {
          await client.query(
            `UPDATE performance_reviews
             SET self_assessment = $1, self_assessment_submitted_at = now()
             WHERE id = $2`,
            [
              `I have successfully completed my projects and collaborated well with the team.`,
              review.rows[0].id,
            ]
          );
        }

        // Add manager assessment for first 2 employees
        if (i < 2) {
          await client.query(
            `UPDATE performance_reviews
             SET manager_assessment = $1, manager_rating = $2, manager_assessment_submitted_at = now()
             WHERE id = $3`,
            [
              "Good performance overall. Shows strong technical skills and team collaboration.",
              3,
              review.rows[0].id,
            ]
          );
        }
      }

      console.log("✓ Performance review cycle created with partial submissions");

      console.log("\n✅ Pilot company setup complete!");
      console.log(`\nDemo company: "${companyName}"`);
      console.log(`Employees: ${SEED_EMPLOYEES.length}`);
      console.log(
        "Features ready: Employee Core, Leave, Recruitment, Performance"
      );
      console.log(
        "\nData includes:"
      );
      console.log("  • Department hierarchy with manager reporting chains");
      console.log("  • Employee groups and leave policies (annual/sick/casual)");
      console.log("  • Configured workflow templates for Leave and Recruitment");
      console.log("  • In-flight leave requests at various approval stages");
      console.log("  • Open requisitions with candidates in pipeline");
      console.log("  • Active performance review cycle with partial submissions");
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
