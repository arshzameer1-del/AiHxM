/**
 * The people and structure loaded by seed-tenant-demo.ts: a believable 40-person Pakistani company ("Qatar Solutions
 * Pakistan") with three sites, six departments (IT has two teams), one head per department, everyone reporting up to the CEO.
 * Names, CNICs and phone numbers are made up (CNIC and phone follow the real formats; emails use the reserved .example
 * domain so nothing can be mailed to a real person).
 */

export type DemoLocation = { key: string; parent?: string; type: "country" | "region" | "city" | "site" | "building"; code: string; name: string; address?: string };

export const DEMO_LOCATIONS: DemoLocation[] = [
  { key: "pk", type: "country", code: "PK", name: "Pakistan" },
  { key: "khi", parent: "pk", type: "city", code: "KHI", name: "Karachi" },
  { key: "lhe", parent: "pk", type: "city", code: "LHE", name: "Lahore" },
  { key: "isb", parent: "pk", type: "city", code: "ISB", name: "Islamabad" },
  { key: "khi-hq", parent: "khi", type: "site", code: "KHI-HQ", name: "Karachi Head Office", address: "I.I. Chundrigar Road, Karachi" },
  { key: "lhe-ofc", parent: "lhe", type: "site", code: "LHE-OFC", name: "Lahore Office", address: "Gulberg III, Lahore" },
  { key: "isb-ofc", parent: "isb", type: "site", code: "ISB-OFC", name: "Islamabad Office", address: "Blue Area, Islamabad" },
];

export type DemoUnit = { key: string; parent?: string; type: "department" | "division" | "business_unit" | "function"; code: string; name: string };

export const DEMO_UNITS: DemoUnit[] = [
  { key: "root", type: "business_unit", code: "QSP", name: "Qatar Solutions Pakistan" },
  { key: "exe", parent: "root", type: "department", code: "EXE", name: "Executive Office" },
  { key: "hr", parent: "root", type: "department", code: "HR", name: "Human Resources" },
  { key: "fin", parent: "root", type: "department", code: "FIN", name: "Finance & Accounts" },
  { key: "it", parent: "root", type: "department", code: "IT", name: "Information Technology" },
  { key: "dev", parent: "it", type: "department", code: "IT-DEV", name: "Software Development" },
  { key: "sup", parent: "it", type: "department", code: "IT-SUP", name: "IT Support" },
  { key: "sal", parent: "root", type: "department", code: "SAL", name: "Sales & Marketing" },
  { key: "ops", parent: "root", type: "department", code: "OPS", name: "Operations" },
];

export type DemoJob = { title: string; code: string; family: string; level: string };

export const DEMO_JOBS: DemoJob[] = [
  { title: "Chief Executive Officer", code: "CEO", family: "operations", level: "L8" },
  { title: "Executive Assistant", code: "EA", family: "operations", level: "L3" },
  { title: "HR Manager", code: "HRM", family: "hr", level: "L6" },
  { title: "HR Officer", code: "HRO", family: "hr", level: "L3" },
  { title: "Payroll Officer", code: "PAYO", family: "hr", level: "L4" },
  { title: "Finance Manager", code: "FINM", family: "finance", level: "L6" },
  { title: "Senior Accountant", code: "SACC", family: "finance", level: "L5" },
  { title: "Accountant", code: "ACC", family: "finance", level: "L4" },
  { title: "IT Manager", code: "ITM", family: "engineering", level: "L6" },
  { title: "Senior Software Engineer", code: "SSE", family: "engineering", level: "L5" },
  { title: "Software Engineer", code: "SE", family: "engineering", level: "L4" },
  { title: "QA Engineer", code: "QA", family: "engineering", level: "L4" },
  { title: "DevOps Engineer", code: "DEVOPS", family: "engineering", level: "L4" },
  { title: "UI/UX Designer", code: "UX", family: "marketing", level: "L4" },
  { title: "IT Support Engineer", code: "ITS", family: "engineering", level: "L3" },
  { title: "Sales Manager", code: "SALM", family: "sales", level: "L6" },
  { title: "Sales Executive", code: "SALE", family: "sales", level: "L3" },
  { title: "Marketing Executive", code: "MKTE", family: "marketing", level: "L3" },
  { title: "Operations Manager", code: "OPSM", family: "operations", level: "L6" },
  { title: "Operations Executive", code: "OPSE", family: "operations", level: "L3" },
  { title: "Logistics Coordinator", code: "LOGC", family: "operations", level: "L3" },
  { title: "Administration Officer", code: "ADMO", family: "operations", level: "L3" },
  { title: "Customer Support Officer", code: "CSO", family: "operations", level: "L3" },
];

export type DemoEmployee = {
  key: string;
  first: string;
  last: string;
  gender: "male" | "female";
  marital: "single" | "married";
  dob: string;
  unit: string;
  job: string; // a DEMO_JOBS title
  site: string; // a DEMO_LOCATIONS key (site)
  manager?: string; // another employee key
  head?: boolean; // head of the department (head position of the unit)
  salary: number; // monthly, PKR
  joined: string;
  type: "permanent" | "contract";
  bank: string;
};

/** 40 people. Heads report to the CEO, everyone else to their department head (IT teams: to the IT manager). */
export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { key: "ceo", first: "Imran", last: "Qureshi", gender: "male", marital: "married", dob: "1976-03-14", unit: "exe", job: "Chief Executive Officer", site: "khi-hq", head: true, salary: 950000, joined: "2018-01-08", type: "permanent", bank: "Meezan Bank" },
  { key: "ea", first: "Sana", last: "Mirza", gender: "female", marital: "single", dob: "1992-09-02", unit: "exe", job: "Executive Assistant", site: "khi-hq", manager: "ceo", salary: 145000, joined: "2020-02-17", type: "permanent", bank: "HBL" },

  { key: "hrm", first: "Ayesha", last: "Siddiqui", gender: "female", marital: "married", dob: "1983-11-21", unit: "hr", job: "HR Manager", site: "khi-hq", manager: "ceo", head: true, salary: 330000, joined: "2018-06-04", type: "permanent", bank: "Meezan Bank" },
  { key: "hro1", first: "Bilal", last: "Ahmed", gender: "male", marital: "single", dob: "1994-05-30", unit: "hr", job: "HR Officer", site: "khi-hq", manager: "hrm", salary: 105000, joined: "2021-03-01", type: "permanent", bank: "UBL" },
  { key: "hro2", first: "Hina", last: "Farooq", gender: "female", marital: "married", dob: "1991-01-12", unit: "hr", job: "HR Officer", site: "isb-ofc", manager: "hrm", salary: 110000, joined: "2021-08-16", type: "permanent", bank: "Bank Alfalah" },
  { key: "hro3", first: "Saima", last: "Latif", gender: "female", marital: "single", dob: "1996-07-19", unit: "hr", job: "HR Officer", site: "lhe-ofc", manager: "hrm", salary: 98000, joined: "2023-01-09", type: "permanent", bank: "HBL" },
  { key: "pay", first: "Kamran", last: "Yousuf", gender: "male", marital: "married", dob: "1988-04-08", unit: "hr", job: "Payroll Officer", site: "khi-hq", manager: "hrm", salary: 135000, joined: "2019-10-14", type: "permanent", bank: "MCB" },

  { key: "finm", first: "Faisal", last: "Rehman", gender: "male", marital: "married", dob: "1980-08-25", unit: "fin", job: "Finance Manager", site: "khi-hq", manager: "ceo", head: true, salary: 360000, joined: "2018-04-02", type: "permanent", bank: "Meezan Bank" },
  { key: "sacc", first: "Nadia", last: "Hussain", gender: "female", marital: "married", dob: "1987-12-03", unit: "fin", job: "Senior Accountant", site: "khi-hq", manager: "finm", salary: 215000, joined: "2019-05-20", type: "permanent", bank: "HBL" },
  { key: "acc1", first: "Usman", last: "Tariq", gender: "male", marital: "single", dob: "1993-02-17", unit: "fin", job: "Accountant", site: "khi-hq", manager: "finm", salary: 135000, joined: "2021-09-06", type: "permanent", bank: "UBL" },
  { key: "acc2", first: "Zeeshan", last: "Malik", gender: "male", marital: "married", dob: "1990-10-11", unit: "fin", job: "Accountant", site: "lhe-ofc", manager: "finm", salary: 128000, joined: "2022-04-11", type: "permanent", bank: "Bank Alfalah" },
  { key: "acc3", first: "Hassan", last: "Javaid", gender: "male", marital: "single", dob: "1997-06-23", unit: "fin", job: "Accountant", site: "isb-ofc", manager: "finm", salary: 118000, joined: "2024-02-05", type: "permanent", bank: "MCB" },

  { key: "itm", first: "Omar", last: "Farooqui", gender: "male", marital: "married", dob: "1981-06-09", unit: "it", job: "IT Manager", site: "khi-hq", manager: "ceo", head: true, salary: 390000, joined: "2018-03-12", type: "permanent", bank: "Meezan Bank" },
  { key: "sse", first: "Hamza", last: "Sheikh", gender: "male", marital: "married", dob: "1988-09-27", unit: "dev", job: "Senior Software Engineer", site: "khi-hq", manager: "itm", salary: 285000, joined: "2019-01-14", type: "permanent", bank: "HBL" },
  { key: "se1", first: "Maryam", last: "Javed", gender: "female", marital: "single", dob: "1995-03-04", unit: "dev", job: "Software Engineer", site: "khi-hq", manager: "sse", salary: 185000, joined: "2021-06-21", type: "permanent", bank: "UBL" },
  { key: "se2", first: "Ali", last: "Raza", gender: "male", marital: "single", dob: "1996-11-15", unit: "dev", job: "Software Engineer", site: "khi-hq", manager: "sse", salary: 175000, joined: "2022-07-18", type: "permanent", bank: "Bank Alfalah" },
  { key: "se3", first: "Sadia", last: "Noor", gender: "female", marital: "married", dob: "1993-08-01", unit: "dev", job: "Software Engineer", site: "lhe-ofc", manager: "sse", salary: 180000, joined: "2022-10-03", type: "permanent", bank: "MCB" },
  { key: "se4", first: "Fahad", last: "Chaudhry", gender: "male", marital: "single", dob: "1998-01-29", unit: "dev", job: "Software Engineer", site: "lhe-ofc", manager: "sse", salary: 160000, joined: "2023-05-15", type: "contract", bank: "HBL" },
  { key: "se5", first: "Owais", last: "Hashmi", gender: "male", marital: "single", dob: "1999-02-11", unit: "dev", job: "Software Engineer", site: "khi-hq", manager: "sse", salary: 155000, joined: "2025-03-03", type: "permanent", bank: "UBL" },
  { key: "qa", first: "Danish", last: "Iqbal", gender: "male", marital: "single", dob: "1994-12-20", unit: "dev", job: "QA Engineer", site: "khi-hq", manager: "sse", salary: 150000, joined: "2022-02-14", type: "permanent", bank: "UBL" },
  { key: "devops", first: "Ahsan", last: "Raza", gender: "male", marital: "married", dob: "1991-05-06", unit: "dev", job: "DevOps Engineer", site: "isb-ofc", manager: "itm", salary: 225000, joined: "2023-09-11", type: "permanent", bank: "Meezan Bank" },
  { key: "ux", first: "Mahnoor", last: "Farid", gender: "female", marital: "single", dob: "1997-04-18", unit: "dev", job: "UI/UX Designer", site: "khi-hq", manager: "sse", salary: 145000, joined: "2024-06-03", type: "permanent", bank: "HBL" },
  { key: "its1", first: "Tahir", last: "Mehmood", gender: "male", marital: "married", dob: "1989-07-13", unit: "sup", job: "IT Support Engineer", site: "khi-hq", manager: "itm", salary: 95000, joined: "2020-11-23", type: "permanent", bank: "MCB" },
  { key: "its2", first: "Iqra", last: "Saleem", gender: "female", marital: "single", dob: "1998-10-09", unit: "sup", job: "IT Support Engineer", site: "isb-ofc", manager: "itm", salary: 88000, joined: "2024-01-22", type: "permanent", bank: "Bank Alfalah" },

  { key: "salm", first: "Saad", last: "Butt", gender: "male", marital: "married", dob: "1982-02-26", unit: "sal", job: "Sales Manager", site: "lhe-ofc", manager: "ceo", head: true, salary: 340000, joined: "2018-09-03", type: "permanent", bank: "Meezan Bank" },
  { key: "sale1", first: "Mehwish", last: "Aslam", gender: "female", marital: "married", dob: "1990-06-14", unit: "sal", job: "Sales Executive", site: "lhe-ofc", manager: "salm", salary: 120000, joined: "2020-07-06", type: "permanent", bank: "HBL" },
  { key: "sale2", first: "Junaid", last: "Akhtar", gender: "male", marital: "single", dob: "1993-09-08", unit: "sal", job: "Sales Executive", site: "lhe-ofc", manager: "salm", salary: 115000, joined: "2021-04-12", type: "permanent", bank: "UBL" },
  { key: "sale3", first: "Anum", last: "Khalid", gender: "female", marital: "single", dob: "1996-02-22", unit: "sal", job: "Sales Executive", site: "khi-hq", manager: "salm", salary: 112000, joined: "2022-09-19", type: "permanent", bank: "MCB" },
  { key: "sale4", first: "Rizwan", last: "Ullah", gender: "male", marital: "married", dob: "1991-12-30", unit: "sal", job: "Sales Executive", site: "isb-ofc", manager: "salm", salary: 118000, joined: "2022-12-05", type: "permanent", bank: "Bank Alfalah" },
  { key: "sale5", first: "Taimoor", last: "Khan", gender: "male", marital: "single", dob: "1998-08-16", unit: "sal", job: "Sales Executive", site: "lhe-ofc", manager: "salm", salary: 100000, joined: "2024-08-12", type: "contract", bank: "HBL" },
  { key: "mkt1", first: "Laiba", last: "Shah", gender: "female", marital: "single", dob: "1997-11-05", unit: "sal", job: "Marketing Executive", site: "khi-hq", manager: "salm", salary: 110000, joined: "2023-03-13", type: "permanent", bank: "UBL" },
  { key: "mkt2", first: "Waqas", last: "Hameed", gender: "male", marital: "married", dob: "1992-03-28", unit: "sal", job: "Marketing Executive", site: "lhe-ofc", manager: "salm", salary: 115000, joined: "2023-11-27", type: "permanent", bank: "MCB" },

  { key: "opsm", first: "Shahid", last: "Mahmood", gender: "male", marital: "married", dob: "1979-10-04", unit: "ops", job: "Operations Manager", site: "isb-ofc", manager: "ceo", head: true, salary: 350000, joined: "2018-05-14", type: "permanent", bank: "Meezan Bank" },
  { key: "ope1", first: "Farah", last: "Naz", gender: "female", marital: "married", dob: "1989-01-17", unit: "ops", job: "Operations Executive", site: "isb-ofc", manager: "opsm", salary: 125000, joined: "2019-08-26", type: "permanent", bank: "HBL" },
  { key: "ope2", first: "Adeel", last: "Khan", gender: "male", marital: "single", dob: "1994-07-07", unit: "ops", job: "Operations Executive", site: "isb-ofc", manager: "opsm", salary: 118000, joined: "2021-10-18", type: "permanent", bank: "UBL" },
  { key: "ope3", first: "Naveed", last: "Akram", gender: "male", marital: "married", dob: "1990-04-25", unit: "ops", job: "Operations Executive", site: "khi-hq", manager: "opsm", salary: 120000, joined: "2022-05-23", type: "permanent", bank: "MCB" },
  { key: "ope4", first: "Zainab", last: "Ali", gender: "female", marital: "single", dob: "1997-12-12", unit: "ops", job: "Operations Executive", site: "lhe-ofc", manager: "opsm", salary: 108000, joined: "2024-03-18", type: "permanent", bank: "Bank Alfalah" },
  { key: "log", first: "Rehan", last: "Ali", gender: "male", marital: "single", dob: "1995-09-14", unit: "ops", job: "Logistics Coordinator", site: "khi-hq", manager: "opsm", salary: 98000, joined: "2021-12-06", type: "permanent", bank: "HBL" },
  { key: "adm", first: "Sumaira", last: "Bibi", gender: "female", marital: "married", dob: "1986-05-03", unit: "ops", job: "Administration Officer", site: "isb-ofc", manager: "opsm", salary: 92000, joined: "2019-02-11", type: "permanent", bank: "UBL" },
  { key: "cso", first: "Asma", last: "Rafiq", gender: "female", marital: "single", dob: "1998-03-09", unit: "ops", job: "Customer Support Officer", site: "khi-hq", manager: "opsm", salary: 85000, joined: "2025-01-13", type: "permanent", bank: "MCB" },
];

/** A made-up but correctly formatted CNIC (13 digits) and mobile number, stable for the same person. */
export function demoCnic(i: number): string {
  const body = String(2000000 + i * 7919).padStart(7, "0").slice(0, 7);
  return `35202-${body}-${(i * 3 + 1) % 10}`;
}
export function demoPhone(i: number): string {
  return `0300-${String(1200000 + i * 4231).slice(0, 7)}`;
}
export function demoEmail(e: { first: string; last: string }): string {
  return `${e.first}.${e.last}`.toLowerCase().replace(/[^a-z.]/g, "") + "@qatarsolutions.example";
}
/** A 24-character Pakistani IBAN built from a valid mod-97 check (bank code is a fixed 4 letters). */
export function demoIban(i: number, bankCode = "MUCB"): string {
  const account = String(1000000000000000 + i * 91357).padStart(16, "0").slice(0, 16);
  const bban = `${bankCode}${account}`;
  const numeric = (bban + "PK00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, "0");
  return `PK${check}${bban}`;
}

// ---- the other modules' sample records -----------------------------------------------------------------------------

export type DemoChecklistItem = { title: string; category: "it" | "hr" | "finance" | "facilities" | "general"; role: "self" | "team" | "all"; days?: number };

export const DEMO_ONBOARDING: DemoChecklistItem[] = [
  { title: "Sign the employment contract and policy acknowledgements", category: "hr", role: "self", days: 1 },
  { title: "Submit CNIC copy, photographs and educational documents", category: "hr", role: "self", days: 3 },
  { title: "Set up laptop, email account and system access", category: "it", role: "team", days: 1 },
  { title: "Allocate desk, access card and parking", category: "facilities", role: "team", days: 1 },
  { title: "Collect bank account details for salary", category: "finance", role: "self", days: 5 },
  { title: "Office orientation and introduction to the team", category: "general", role: "team", days: 2 },
  { title: "Complete the code of conduct and information security course", category: "general", role: "self", days: 14 },
];

export const DEMO_OFFBOARDING: DemoChecklistItem[] = [
  { title: "Submit the resignation letter and agree the last working day", category: "hr", role: "self" },
  { title: "Hand over work and documents to the team", category: "general", role: "self" },
  { title: "Return laptop, access card and other company property", category: "facilities", role: "self" },
  { title: "Disable email, VPN and system accounts", category: "it", role: "team" },
  { title: "Clear loans and advances; prepare final settlement", category: "finance", role: "team" },
  { title: "Exit interview", category: "hr", role: "team" },
];

export const DEMO_COURSES: Array<{ title: string; description: string; category: "compliance" | "technical" | "soft_skills" | "leadership" | "other"; minutes: number; everyone?: boolean; units?: string[] }> = [
  { title: "Code of Conduct and Workplace Ethics", description: "What the company expects from every employee: conduct, conflicts of interest, reporting concerns.", category: "compliance", minutes: 45, everyone: true },
  { title: "Information Security Basics", description: "Passwords, phishing, safe handling of customer and employee data.", category: "compliance", minutes: 60, everyone: true },
  { title: "Secure Coding Practices", description: "Common vulnerabilities and how to avoid them in daily development work.", category: "technical", minutes: 180, units: ["dev", "sup"] },
  { title: "Effective Business Communication", description: "Clear emails, meetings that finish on time, giving and receiving feedback.", category: "soft_skills", minutes: 90, units: ["sal", "ops", "hr"] },
  { title: "Leading a Team for the First Time", description: "Delegation, one-to-ones and handling difficult conversations for new managers.", category: "leadership", minutes: 240, units: ["exe"] },
];

export const DEMO_COMPETENCIES: Array<{ code: string; name: string; description: string; category: string }> = [
  { code: "comm", name: "Communication", description: "Explains ideas clearly and listens before replying.", category: "Core" },
  { code: "team", name: "Teamwork", description: "Works with others to reach shared goals and helps colleagues succeed.", category: "Core" },
  { code: "own", name: "Ownership", description: "Takes responsibility for results and follows through.", category: "Core" },
  { code: "cust", name: "Customer focus", description: "Understands what the customer needs and acts on it.", category: "Core" },
  { code: "lead", name: "Leadership", description: "Sets direction, develops people and makes timely decisions.", category: "Leadership" },
];

export const DEMO_LEAVE_POLICIES = {
  permanent: { name: "Permanent employees", annual: 20, casual: 10, sick: 8, isDefault: true },
  contract: { name: "Contract employees", annual: 14, casual: 8, sick: 6, isDefault: false },
};

export const DEMO_CANDIDATES: Array<{ first: string; last: string; source: "referral" | "job_board" | "company_website" | "agency" | "social_media" | "campus"; employer: string; designation: string; expected: number; notice: number; stage: "applied" | "screening" | "interview" | "rejected"; requisition: 0 | 1 | 2; reason?: string }> = [
  { first: "Hamza", last: "Farooq", source: "job_board", employer: "Systems Limited", designation: "Software Engineer", expected: 260000, notice: 30, stage: "interview", requisition: 0 },
  { first: "Sana", last: "Tariq", source: "referral", employer: "Netsol Technologies", designation: "Senior Software Engineer", expected: 340000, notice: 30, stage: "screening", requisition: 0 },
  { first: "Usman", last: "Ghani", source: "company_website", employer: "Arbisoft", designation: "Software Engineer", expected: 240000, notice: 15, stage: "applied", requisition: 0 },
  { first: "Mariam", last: "Anwar", source: "campus", employer: "FAST-NUCES (graduate)", designation: "Fresh graduate", expected: 120000, notice: 0, stage: "rejected", requisition: 0, reason: "Does not meet the minimum experience for this role" },
  { first: "Bilal", last: "Chaudhry", source: "social_media", employer: "K-Electric", designation: "Sales Officer", expected: 130000, notice: 30, stage: "interview", requisition: 1 },
  { first: "Nimra", last: "Javed", source: "job_board", employer: "Engro", designation: "Marketing Coordinator", expected: 145000, notice: 30, stage: "screening", requisition: 1 },
  { first: "Faisal", last: "Mehmood", source: "agency", employer: "Daraz Pakistan", designation: "Account Manager", expected: 170000, notice: 45, stage: "applied", requisition: 1 },
  { first: "Aleena", last: "Siddique", source: "referral", employer: "Habib Bank", designation: "Accounts Officer", expected: 155000, notice: 30, stage: "interview", requisition: 2 },
  { first: "Taimoor", last: "Akram", source: "job_board", employer: "Deloitte Yousuf Adil", designation: "Associate Accountant", expected: 140000, notice: 30, stage: "screening", requisition: 2 },
  { first: "Rabia", last: "Nasir", source: "company_website", employer: "Self-employed", designation: "Bookkeeper", expected: 110000, notice: 7, stage: "applied", requisition: 2 },
];

export const DEMO_REQUISITIONS = [
  { title: "Senior Software Engineer", unit: "dev", job: "Senior Software Engineer", site: "khi-hq", manager: "itm", headcount: 2, band: "L5", why: "Two engineers to take on the customer portal roadmap." },
  { title: "Sales Executive", unit: "sal", job: "Sales Executive", site: "lhe-ofc", manager: "salm", headcount: 1, band: "L3", why: "Cover the Lahore region after the current executive moved to key accounts." },
  { title: "Accountant", unit: "fin", job: "Accountant", site: "khi-hq", manager: "finm", headcount: 1, band: "L4", why: "Month-end close needs a further pair of hands." },
];

export const DEMO_GOALS: Array<{ title: string; description: string; weight: number; target?: number; unit?: string; units: string[] }> = [
  { title: "Deliver the work planned for the year on time", description: "Complete the quarterly plan agreed with your manager, with no more than one slipped milestone.", weight: 40, units: ["exe", "hr", "fin", "it", "dev", "sup", "sal", "ops"] },
  { title: "Raise quality and reduce rework", description: "Cut rework and repeat corrections in your area by a quarter compared with last year.", weight: 30, units: ["exe", "hr", "fin", "dev", "sup", "ops"] },
  { title: "Close new business", description: "Win new customer orders against the annual target.", weight: 30, target: 12000000, unit: "PKR", units: ["sal"] },
  { title: "Complete two development courses", description: "Finish the courses agreed in your development plan.", weight: 30, target: 2, unit: "courses", units: ["exe", "hr", "fin", "it", "dev", "sup", "sal", "ops"] },
];

export const DEMO_EXPENSES: Array<{ category: "travel" | "meals" | "accommodation" | "office_supplies" | "communication" | "training" | "other"; date: string; amount: number; description: string }> = [
  { category: "travel", date: "2026-09-08", amount: 18500, description: "Return flight Karachi to Lahore for the vendor meeting" },
  { category: "meals", date: "2026-09-09", amount: 4200, description: "Working lunch with the vendor team" },
  { category: "office_supplies", date: "2026-09-21", amount: 7650, description: "Printer cartridges and stationery for the HR office" },
  { category: "training", date: "2026-10-02", amount: 25000, description: "Fee for the HR analytics workshop" },
];
