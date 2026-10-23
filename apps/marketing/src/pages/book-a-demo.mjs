import { site } from "../site.config.mjs";
import { breadcrumbs } from "../layout.mjs";

const INTERESTS = [
  ["core-hr", "Core HR"],
  ["payroll", "Payroll"],
  ["pakistan-payroll", "Pakistan payroll"],
  ["attendance", "Time & attendance"],
  ["leave", "Leave"],
  ["self-service", "Self-service"],
  ["approvals", "Workflows & approvals"],
  ["reporting", "Reports"],
  ["other", "Something else, or pricing"],
];

export default () => {
  const trail = [["Home", "/"], ["Book a demo", "/book-a-demo/"]];
  const body = `
<section class="page-hero"><div class="wrap">${breadcrumbs(trail)}<h1>Book a Personalized Demo</h1><p class="lead">Tell us a little about your company. We will use it to prepare a walkthrough that matches your set-up.</p></div></section>
<section class="section">
  <div class="wrap">
    <div class="split demo-split">
      <div>
        <h2>What happens next</h2>
        <ul class="ticks">
          <li>Your request is saved and our team is told about it.</li>
          <li>We contact you by email to agree a time.</li>
          <li>The demo uses the modules you ticked, with sample data and your questions.</li>
        </ul>
        <div class="callout"><h3>Only what we need</h3><p>Four fields are required: name, work email, company and the privacy tick box. Everything else is optional. Read the <a href="/privacy/">privacy notice</a>.</p></div>
        ${
          site.contactEmail
            ? `<p class="muted">Prefer email? <a href="mailto:${site.contactEmail}">${site.contactEmail}</a></p>`
            : ""
        }
      </div>
      <div class="form-card">
        <div id="form-done" hidden tabindex="-1">
          <h2>Request received</h2>
          <p>Thank you. We saved your request and will email <strong id="done-email"></strong> to agree a time.</p>
          <p class="small muted">Reference: <strong id="done-ref"></strong></p>
          <p><a class="btn btn-ghost" href="/platform/">Explore the Platform meanwhile</a></p>
        </div>
        <form id="demo-form" class="form" novalidate data-api="${site.apiUrl}" data-contact="${site.contactEmail}">
          <div id="form-status" class="form-status" role="alert" tabindex="-1"></div>
          <div class="row2">
            <div class="field" data-field="fullName"><label for="fullName">Full name</label><input type="text" id="fullName" name="fullName" autocomplete="name" required maxlength="120"><p class="err">Enter your name.</p></div>
            <div class="field" data-field="workEmail"><label for="workEmail">Work email</label><input type="email" id="workEmail" name="workEmail" autocomplete="email" required maxlength="200"><p class="err">Enter a valid email address.</p></div>
          </div>
          <div class="row2">
            <div class="field" data-field="companyName"><label for="companyName">Company</label><input type="text" id="companyName" name="companyName" autocomplete="organization" required maxlength="160"><p class="err">Enter your company name.</p></div>
            <div class="field" data-field="phone"><label for="phone">Phone <span class="opt">(optional)</span></label><input type="tel" id="phone" name="phone" autocomplete="tel" maxlength="25"><p class="err">Use digits, spaces, + ( ) and -.</p></div>
          </div>
          <div class="row2">
            <div class="field"><label for="jobTitle">Your role <span class="opt">(optional)</span></label><input type="text" id="jobTitle" name="jobTitle" autocomplete="organization-title" maxlength="120"></div>
            <div class="field"><label for="employeeCount">Number of employees <span class="opt">(optional)</span></label><select id="employeeCount" name="employeeCount"><option value="">Choose</option><option>1-50</option><option>51-200</option><option>201-500</option><option>501-1000</option><option>1000+</option></select></div>
          </div>
          <fieldset class="field"><legend>What would you like to see? <span class="opt">(optional)</span></legend><div class="checks">${INTERESTS.map(
            ([v, l]) => `<label class="check"><input type="checkbox" id="int-${v}" name="interests" value="${v}"> ${l}</label>`
          ).join("")}</div></fieldset>
          <div class="field"><label for="message">Anything we should know? <span class="opt">(optional)</span></label><textarea id="message" name="message" maxlength="2000"></textarea></div>
          <div class="hp" aria-hidden="true"><label for="website">Leave this field empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
          <div class="field" data-field="consentPrivacy"><label class="check"><input type="checkbox" id="consentPrivacy" name="consentPrivacy"> <span>I have read the <a href="/privacy/">privacy notice</a> and agree that AiHxM may use these details to contact me about a demo.</span></label><p class="err">Tick the box to send your request.</p></div>
          <div><button class="btn btn-primary" type="submit" id="form-submit">Send request</button></div>
          <noscript><p class="small">This form needs JavaScript to send.${site.contactEmail ? ` Or email ${site.contactEmail}.` : ""}</p></noscript>
        </form>
      </div>
    </div>
  </div>
</section>
`;
  return {
    path: "/book-a-demo/",
    title: "Book a Personalized Demo",
    description:
      "Book a personalised AiHxM demo. Four required fields, a clear privacy notice, and a walkthrough built around the modules you care about.",
    trail,
    body,
  };
};
