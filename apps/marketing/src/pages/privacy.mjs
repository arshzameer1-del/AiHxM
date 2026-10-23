import { site } from "../site.config.mjs";
import { breadcrumbs } from "../layout.mjs";

export default () => {
  const trail = [["Home", "/"], ["Privacy notice", "/privacy/"]];
  const contactWay = site.contactEmail
    ? `email <a href="mailto:${site.contactEmail}">${site.contactEmail}</a>`
    : `send a message through the <a href="/book-a-demo/">demo form</a> and say it is a privacy request`;
  const body = `
<section class="page-hero"><div class="wrap">${breadcrumbs(trail)}<h1>Privacy notice</h1><p class="lead">What this website collects, why, and how to have it removed.</p></div></section>
<section class="section">
  <div class="wrap narrow prose">
    ${
      site.privacyReviewed
        ? ""
        : `<div class="callout warn"><p class="callout-title">Draft notice</p><p>This is a plain-language draft and has not yet been reviewed by a lawyer. It describes what the website does today.</p></div>`
    }
    <h2>Who we are</h2>
    <p>This website is run by ${site.legalName}, the company behind the AiHxM platform. The product itself, where your company's employee data lives, is covered separately and not by this notice.</p>
    <h2>What we collect</h2>
    <p>Only what you type into the demo form: your name, work email, company name and your message. Optional fields are your phone number, role, company size and the modules you are interested in. We also store the page you sent the form from, and a one-way hash of your network address, which we use to limit abuse. We do not store the address itself.</p>
    <h2>Why we collect it</h2>
    <p>To contact you about a demo, to prepare a walkthrough that matches your interests and, if you ask, to send pricing. We do not use it for anything else.</p>
    <h2>Who sees it</h2>
    <p>Our team, through a protected request list. The details are stored on the same hosted infrastructure that runs AiHxM. If an email notification is switched on, a copy of the request is emailed to our team.</p>
    <h2>Cookies and tracking</h2>
    <p>This website does not set cookies and does not run analytics or advertising trackers. Fonts and images are served from the site itself.</p>
    <h2>How long we keep it</h2>
    <p>For as long as we need it to follow up on your request. We delete a request when you ask us to.</p>
    <h2>Your choices</h2>
    <p>You can ask us what we hold about you, ask us to correct it, or ask us to delete it. To do that, ${contactWay}.</p>
  </div>
</section>
`;
  return {
    path: "/privacy/",
    title: "Privacy notice",
    description: "What the AiHxM website collects through its demo form, why, who sees it, and how to have it deleted. The site sets no cookies and runs no trackers.",
    trail,
    body,
  };
};
