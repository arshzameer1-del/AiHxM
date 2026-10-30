import { careersFeedXml, parseResumeText } from "./resume-parser";

describe("resume text reader", () => {
  const cv = `Ayesha Khan
Email: Ayesha.Khan@Example.com | Mobile: 0300-1234567
Senior accountant with 7 years of experience in audit and tax. Earlier: 3 years experience in payroll.
Skills: Excel, Tax filing, SAP, Public speaking`;

  it("reads name, e-mail, phone, years and the skills the company tracks", () => {
    const r = parseResumeText(cv, ["Excel", "Tax filing", "Python", "SA"]);
    expect(r).toEqual({ firstName: "Ayesha", lastName: "Khan", email: "ayesha.khan@example.com", phone: "03001234567", yearsExperience: 7, matchedSkills: ["Excel", "Tax filing"] });
  });
  it("leaves out what it cannot find instead of guessing", () => {
    const r = parseResumeText("1234 random numbers\nno details here", ["Excel"]);
    expect(r).toMatchObject({ firstName: null, lastName: null, email: null, phone: null, yearsExperience: null, matchedSkills: [] });
  });
  it("reads an international number and ignores a skill that is only part of a longer word", () => {
    const r = parseResumeText("Bilal Ahmed\n+92 321 7654321\nI like Excellent customer care", ["Excel"]);
    expect(r.phone).toBe("+923217654321");
    expect(r.matchedSkills).toEqual([]);
  });
});

describe("careers job feed", () => {
  it("lists jobs and escapes text", () => {
    const x = careersFeedXml({ companyName: "A & B", slug: "ab", jobs: [{ id: "1", title: "Dev <senior>", department: null, location: "Karachi", employmentType: "full_time", description: "Build \"things\"", closesOn: null, postedOn: "2026-10-01" }] }, "https://x.test/careers");
    expect(x).toContain("<title>Dev &lt;senior&gt;</title>");
    expect(x).toContain('company="A &amp; B"');
    expect(x).toContain("<url>https://x.test/careers/ab/jobs/1</url>");
  });
});
