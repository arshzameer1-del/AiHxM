import type { ParsedResume } from "@aihxm/shared-types";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads pasted resume text with plain pattern rules: the first e-mail address, a phone number, a name from the first line,
 * the largest "N years of experience" figure, and which skills from the company's own catalogue the text mentions.
 * It suggests; a person checks every value before it is used. It is not a machine-learning parser and it reads text only.
 */
export function parseResumeText(text: string, skillNames: string[]): ParsedResume {
  const t = (text ?? "").slice(0, 60000);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(t)?.[0].toLowerCase() ?? null;
  const pk = /(?:\+?92|0)[\s-]?3\d{2}[\s-]?\d{7}/.exec(t)?.[0];
  const generic = /\+?\d[\d\s\-()]{8,16}\d/.exec(t)?.[0];
  const phone = (pk ?? generic ?? "").replace(/[^\d+]/g, "") || null;

  let firstName: string | null = null;
  let lastName: string | null = null;
  const first = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (first.length <= 60 && !/[\d@:/]/.test(first)) {
    const words = first.replace(/^(resume|cv|curriculum vitae)\s*[-–:]?\s*/i, "").split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w));
    if (words.length >= 2 && words.length <= 4) {
      const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      firstName = cap(words[0]);
      lastName = words.slice(1).map(cap).join(" ");
    }
  }

  let years: number | null = null;
  for (const m of t.matchAll(/(\d{1,2})\+?\s*(?:years?|yrs?)\b(?:\s+of)?\s+(?:\w+\s+)?experience/gi)) {
    const n = Number(m[1]);
    if (n <= 50 && (years === null || n > years)) years = n;
  }

  const lower = t.toLowerCase();
  const matchedSkills = skillNames.filter((s) => s.trim() && new RegExp(`(^|[^a-z0-9])${esc(s.trim().toLowerCase())}($|[^a-z0-9])`).test(lower));
  return { firstName, lastName, email, phone, yearsExperience: years, matchedSkills };
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** A plain job feed that aggregators and job boards can read. It lists only what the public careers page already shows. */
export function careersFeedXml(page: { companyName: string; slug: string; jobs: Array<{ id: string; title: string; department: string | null; location: string | null; employmentType: string | null; description: string | null; closesOn: string | null; postedOn: string | null }> }, baseUrl: string): string {
  const jobs = page.jobs
    .map(
      (j) =>
        `  <job>\n    <id>${xml(j.id)}</id>\n    <title>${xml(j.title)}</title>\n    <company>${xml(page.companyName)}</company>\n` +
        `    <url>${xml(`${baseUrl}/${page.slug}/jobs/${j.id}`)}</url>\n    <department>${xml(j.department ?? "")}</department>\n    <location>${xml(j.location ?? "")}</location>\n` +
        `    <employment_type>${xml(j.employmentType ?? "")}</employment_type>\n    <posted_on>${xml(j.postedOn ?? "")}</posted_on>\n    <closes_on>${xml(j.closesOn ?? "")}</closes_on>\n` +
        `    <description>${xml(j.description ?? "")}</description>\n  </job>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<jobs company="${xml(page.companyName)}">\n${jobs}\n</jobs>\n`;
}
