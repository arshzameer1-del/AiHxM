import { pageHero, ctaBand } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["About", "/about/"]];
  const body = `
${pageHero({
  trail,
  title: "HR software shaped around Pakistani businesses.",
  lead: "AiHxM brings HR, payroll, attendance and performance management together for small and mid-size companies in Pakistan.",
  actions: false,
})}
<section class="section">
  <div class="wrap">
    <div class="split">
      <div class="prose">
        <h2>Why it exists</h2>
        <p>Large global HR suites are built for large global companies. Pakistani small and mid-size businesses deserve the same joined-up approach, with one record behind payroll, leave, attendance and approvals, built around how they work: CNIC on the record, a July to June tax year, EOBI and social-security reporting, and Eid holidays that depend on the moon.</p>
        <p>So we are building that platform locally, as a multi-company service where every company runs in its own isolated space.</p>
      </div>
      <div class="card">
        <h3>How we work</h3>
        <ul class="ticks">
          <li><strong>We say what is built.</strong> Every feature on this site carries a status, and gaps are listed.</li>
          <li><strong>Your numbers stay yours.</strong> Rates and policies are company settings, not hidden constants.</li>
          <li><strong>One record.</strong> A change made once reaches every module.</li>
        </ul>
      </div>
    </div>
  </div>
</section>
${ctaBand({})}
`;
  return {
    path: "/about/",
    title: "About AiHxM",
    description:
      "AiHxM is an HR, payroll, attendance and performance platform built for Pakistani small and mid-size businesses, where every company runs in its own isolated space.",
    trail,
    body,
  };
};
