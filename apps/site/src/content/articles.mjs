// Educational articles. Rules: no competitor names; no tax slab, wage base or contribution rate is ever stated (they change
// by budget, notification and province); statutory statements stay general and point to the official source to verify.
export const categories = [
  ["hr-management", "HR Management"], ["pakistan-payroll", "Pakistan Payroll"], ["income-tax", "Income Tax"], ["eobi", "EOBI"],
  ["attendance", "Attendance"], ["leave-management", "Leave Management"], ["recruitment", "Recruitment"], ["performance", "Performance"],
  ["employee-experience", "Employee Experience"], ["hr-automation", "HR Automation"], ["workforce-analytics", "Workforce Analytics"], ["hr-technology", "HR Technology"],
];

export const sources = {
  fbr: ["Federal Board of Revenue", "https://www.fbr.gov.pk"],
  eobi: ["Employees' Old-Age Benefits Institution", "https://www.eobi.gov.pk"],
  code: ["Pakistan Code (official legal database)", "https://pakistancode.gov.pk"],
};

export const articles = [
  { slug: "complete-guide-to-hrms-in-pakistan", title: "Complete Guide to HRMS in Pakistan", cat: "hr-technology", desc: "What an HRMS is, what it should cover for a Pakistani business, and how to choose and introduce one without disruption.",
    related: ["pakistan-payroll-processing-explained", "how-to-digitize-hr-operations", "building-an-efficient-hr-department"], links: ["core-hr", "payroll"],
    body: [
      { h: "What an HRMS is", p: ["An HRMS, or human resource management system, is software that keeps the records and runs the routine processes of HR in one place: employee data, leave, attendance, payroll, recruitment and more. The value comes from the connections. When leave, attendance and payroll read the same employee record, nobody types the same fact twice."] },
      { h: "What a Pakistani business should expect it to cover", p: ["Beyond the general modules, look for features that match local practice."], ul: ["A July-to-June tax year and salary tax by tax year", "CNIC and NTN records and EOBI information", "Provincial social security and welfare-fund settings that you control", "Local holiday calendars, including dates that depend on moon sighting", "Payment files for the banks you use, in a layout you can define"] },
      { h: "How to choose", p: ["Ask to see your own scenario, not a demo script: a mid-month joiner, a back-dated raise, a leave request that needs two approvals. Check who can change the rules, you or the vendor, and whether statutory rates are yours to maintain. Ask what is available today and what is planned, and get the difference in writing."] },
      { h: "Introducing it well", p: ["Move the data first and clean it as you go. Run payroll in parallel with your current method for at least one cycle. Train managers and employees as well as HR, because self-service only saves time when people use it."] },
    ] },
  { slug: "pakistan-payroll-processing-explained", title: "Pakistan Payroll Processing Explained", cat: "pakistan-payroll", desc: "The steps of a monthly payroll cycle in Pakistan, from inputs to payment and records, and where mistakes usually enter.",
    related: ["understanding-pakistan-salary-income-tax", "eobi-contributions-explained", "improving-payroll-accuracy"], links: ["payroll", "pakistan-payroll"],
    body: [
      { h: "The monthly cycle", p: ["Payroll repeats the same steps every month. Collect the inputs, calculate gross pay, apply deductions, review the result, approve it, pay it and keep the records."], ol: ["Inputs: attendance, leave, overtime, new joiners, leavers, loans and reimbursements", "Gross pay: salary components, allowances and any arrears", "Deductions: income tax, EOBI and social security where applicable, loans and other deductions", "Net pay and review: compare with last month and investigate large changes", "Approval and payment: authorise, then pay by bank transfer or file", "Records: payslips, statutory statements and an accounting entry"] },
      { h: "Where mistakes enter", p: ["Most errors come from inputs that change late: a joiner whose start date moved, unpaid leave entered after the run, a salary revision applied from the wrong month. Reviewing the difference against the previous month catches many of them before money moves."] },
      { h: "Statutory amounts", p: ["Tax slabs, contribution rates and wage bases are set by law or notification and are revised over time, sometimes differently by province. Confirm the current figures with your accountant or the official source before configuring them."], },
      { h: "After the run", p: ["Reconcile what the bank paid with what payroll calculated, file statutory statements as your obligations require, and keep payslips available to employees."] },
    ], refs: ["fbr", "eobi"] },
  { slug: "understanding-pakistan-salary-income-tax", title: "Understanding Pakistan Salary Income Tax", cat: "income-tax", desc: "How salary tax works in outline: the tax year, slabs, withholding by the employer, certificates and why you should always verify current rates.",
    related: ["pakistan-payroll-processing-explained", "improving-payroll-accuracy", "eobi-contributions-explained"], links: ["payroll", "pakistan-payroll"],
    body: [
      { h: "The tax year", p: ["Pakistan's tax year for salaried individuals runs from 1 July to 30 June. Salary tax is therefore worked out and settled across that period, not by calendar year."] },
      { h: "Slabs and rates change", p: ["Income tax on salary is progressive: higher slices of income are taxed at higher rates. The slabs and rates are set in the Finance Act and have been revised in recent budgets, so a figure remembered from last year may be wrong. This article does not quote them for that reason. Always take the current slabs from the Federal Board of Revenue or the Finance Act."] },
      { h: "What the employer does", p: ["Employers deduct salary tax from pay each month under the Income Tax Ordinance, 2001, deposit it, and give the employee a certificate of the tax deducted. A common method is to estimate the tax for the whole year and spread it across the months, adjusting as pay changes. That is why a mid-year raise or bonus changes the monthly deduction for the rest of the year."] },
      { h: "Exemptions and profiles", p: ["Some employees have different treatment, for example certain exemptions or a different tax profile. These should be recorded against the employee so that the calculation is consistent and explainable."] },
      { h: "Good practice", ol: ["Keep slabs as dated data so past months can be explained", "Show the tax calculation on the payslip trail", "Reconcile tax withheld with what you deposit", "Issue year-end certificates on time"] },
    ], refs: ["fbr", "code"] },
  { slug: "eobi-contributions-explained", title: "EOBI Contributions Explained", cat: "eobi", desc: "What EOBI is, who contributes, and how to keep your contribution settings correct when the wage base or rate is revised.",
    related: ["pakistan-payroll-processing-explained", "understanding-pakistan-salary-income-tax", "improving-payroll-accuracy"], links: ["payroll", "pakistan-payroll"],
    body: [
      { h: "What EOBI is", p: ["The Employees' Old-Age Benefits Institution (EOBI) is a federal body that provides old-age benefits to registered workers. It operates under the Employees' Old-Age Benefits Act, 1976."] },
      { h: "Who contributes", p: ["Contributions are made by the employer and by the insured employee, calculated on a wage base and rates that the government can revise by notification. Because those figures change, a payroll system should treat them as settings you maintain, with an effective date."] },
      { h: "Keeping it right", ul: ["Record each eligible employee's EOBI information on the employee file", "Enter the current wage base and rates from the official source or your accountant", "Keep a dated history so old months stay explainable", "Review the figures whenever a notification is issued"] },
      { h: "A caution", p: ["Different sources have quoted different wage bases at different times. Do not rely on a blog or a remembered number; check the official EOBI source."] },
    ], refs: ["eobi", "code"] },
  { slug: "attendance-management-best-practices", title: "Attendance Management Best Practices", cat: "attendance", desc: "Practical ways to record time fairly, handle exceptions and keep attendance data payroll-ready.",
    related: ["improving-payroll-accuracy", "hr-automation-for-growing-businesses", "employee-self-service-benefits"], links: ["attendance", "leave"],
    body: [
      { h: "Start from the shift", p: ["Late, early and absent only mean something against a defined shift. Define shifts and who works them before choosing how to record punches."] },
      { h: "Make recording easy", p: ["Whether people use a web clock, a phone or a device at the gate, the easier the method, the cleaner the data. Remove steps that people skip."] },
      { h: "Plan for exceptions", ul: ["Forgotten clock-outs need a rule, such as closing the day at shift end and marking it clearly", "Corrections should be requests with an approver, not edits", "Work away from the office needs an on-duty request", "Overtime needs a cap and, ideally, approval before the hours are worked"] },
      { h: "Close the loop with payroll", p: ["Approved overtime and unpaid absence should flow into payroll without retyping. Review the exceptions list before each run, not during it."] },
    ] },
  { slug: "how-to-digitize-hr-operations", title: "How to Digitize HR Operations", cat: "hr-management", desc: "A step-by-step approach to moving HR from spreadsheets and paper to one system, without disruption.",
    related: ["complete-guide-to-hrms-in-pakistan", "hr-automation-for-growing-businesses", "building-an-efficient-hr-department"], links: ["core-hr", "configuration-center"],
    body: [
      { h: "Map what you do today", p: ["List the HR processes you run and who does each. Note where information is retyped, where approvals happen by message and where documents are kept on paper."] },
      { h: "Fix the data first", p: ["A system is only as good as its records. Clean the employee list before moving it: duplicates, wrong dates and missing identity numbers cause problems later."] },
      { h: "Digitise in an order that pays back", ol: ["Employee records and documents", "Leave and attendance", "Approvals", "Payroll, once the inputs are reliable", "Reporting"] },
      { h: "Keep your own rules", p: ["Configure the system to match your policies rather than changing policy to suit the tool. Where your process is poor, improve it deliberately, not by accident."] },
      { h: "Bring people with you", p: ["Train managers and employees. Self-service reduces HR workload only if people know it exists and trust it."] },
    ] },
  { slug: "employee-self-service-benefits", title: "Employee Self-Service Benefits", cat: "employee-experience", desc: "Why letting employees see and request things themselves reduces HR work and builds trust.",
    related: ["how-to-digitize-hr-operations", "building-an-efficient-hr-department", "attendance-management-best-practices"], links: ["employee-self-service", "manager-self-service"],
    body: [
      { h: "What it is", p: ["Employee self-service lets people view their own payslips, leave balances and attendance and request leave, expenses or changes to their details without going through HR."] },
      { h: "Why it helps HR", p: ["A large share of HR time goes to answering the same questions: where is my payslip, how many days do I have left. When the answer is one click away, those requests disappear."] },
      { h: "Why it helps employees", p: ["People like knowing where they stand. Transparency about balances and pay lowers the number of disputes and builds trust."] },
      { h: "Keep control", p: ["Self-service should not mean uncontrolled editing. Changes to sensitive details are better handled as requests that HR approves, with a history of what changed."] },
      { h: "Make it reachable", p: ["Many employees will use a phone. An installable web app avoids the need for a separate app on every device."] },
    ] },
  { slug: "improving-payroll-accuracy", title: "Improving Payroll Accuracy", cat: "pakistan-payroll", desc: "Controls that catch payroll errors before they reach employees.",
    related: ["pakistan-payroll-processing-explained", "understanding-pakistan-salary-income-tax", "attendance-management-best-practices"], links: ["payroll", "reports-analytics"],
    body: [
      { h: "Accuracy is a process", p: ["Most payroll errors are not arithmetic. They come from wrong inputs, late changes and unexplained differences. Controls around the calculation matter more than the calculation."] },
      { h: "Controls that work", ul: ["Compare each run with the previous month and investigate large changes", "Lock inputs by a cut-off date and handle later changes as adjustments", "Run a simulation before the real run", "Require a second person to approve", "Reconcile payments with the payroll after the run"] },
      { h: "Keep an audit trail", p: ["Know who changed a salary, when, and why. If a finalised run is wrong, correct it by reversal and a new run so the history stays honest."] },
      { h: "Check statutory settings", p: ["Whenever a tax or contribution notification changes, update the settings with an effective date and review a sample payslip."] },
    ] },
  { slug: "hr-automation-for-growing-businesses", title: "HR Automation for Growing Businesses", cat: "hr-automation", desc: "Which HR tasks to automate first as a company grows, and which to leave to people.",
    related: ["how-to-digitize-hr-operations", "attendance-management-best-practices", "building-an-efficient-hr-department"], links: ["workflows", "configuration-center"],
    body: [
      { h: "Automate the repeatable", p: ["Start with tasks that are frequent, rule-based and error-prone: leave balances, approvals routing, reminders for expiring documents and due training, onboarding checklists."] },
      { h: "Keep people in the loop", p: ["Automation should prepare decisions, not hide them. Hiring, discipline and pay changes need a person to decide, with the system recording who and why."] },
      { h: "Rules, not magic", p: ["Good automation is explicit. You should be able to say why a request went to a particular approver or why a balance changed."] },
      { h: "Measure the effect", p: ["Track time saved on the tasks you automated and the number of errors, so you know the effort paid off."] },
    ] },
  { slug: "building-an-efficient-hr-department", title: "Building an Efficient HR Department", cat: "hr-management", desc: "How to organise HR work so a small team can serve a growing business.",
    related: ["how-to-digitize-hr-operations", "employee-self-service-benefits", "hr-automation-for-growing-businesses"], links: ["hr-help-desk", "core-hr"],
    body: [
      { h: "Separate the routine from the strategic", p: ["HR teams often spend most of their time on routine requests. Moving those to self-service and a tracked help desk frees time for hiring, development and policy."] },
      { h: "Standardise", p: ["Use templates for letters, checklists for joining and leaving, and workflows for approvals. Consistency reduces rework and makes the process teachable."] },
      { h: "Know your numbers", p: ["Keep a small set of measures, such as headcount, attrition, time to hire and request response time, and review them regularly."] },
      { h: "Invest in the people side", p: ["Efficiency is not an end. The time saved should go to the conversations only people can have."] },
    ] },
];
