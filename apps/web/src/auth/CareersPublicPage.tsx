import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MapPin, Briefcase, Clock } from "lucide-react";
import type { CareersEmploymentType, CareersJobView, CareersPageView } from "@aihxm/shared-types";
import { api, ApiError } from "../api/client";

export const EMPLOYMENT_LABEL: Record<CareersEmploymentType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  internship: "Internship",
};

const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
const dayFmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
  return (
    <div className="min-h-screen px-4 py-10">
      <div className="w-full max-w-2xl mx-auto">{children}</div>
      <p className="text-center text-[11px] text-label-tertiary mt-10">Careers page powered by AiHxM</p>
    </div>
  );
}

function JobMeta({ job }: { job: CareersJobView }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-label-tertiary">
      {job.department && <span className="inline-flex items-center gap-1"><Briefcase className="w-3.5 h-3.5" aria-hidden />{job.department}</span>}
      {job.location && <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5" aria-hidden />{job.location}</span>}
      {job.employmentType && <span>{EMPLOYMENT_LABEL[job.employmentType]}</span>}
      {job.closesOn && <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" aria-hidden />Apply by {dayFmt(job.closesOn)}</span>}
    </p>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <Shell title="Careers">
      <div className="bg-card rounded-card shadow-sm p-6 text-center" role="status">
        <h1 className="text-xl font-bold mb-1">{what}</h1>
        <p className="text-sm text-label-tertiary">Please check the address you were given.</p>
      </div>
    </Shell>
  );
}

/** The company's public list of open jobs. No sign-in. */
export function CareersListPage() {
  const { slug = "" } = useParams();
  const [page, setPage] = useState<CareersPageView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api.getPublicCareers(slug).then(setPage).catch(() => setMissing(true));
  }, [slug]);

  if (missing) return <NotFound what="This careers page is not available" />;
  if (!page) return <Shell title="Careers"><p className="text-sm text-label-tertiary text-center">Loading…</p></Shell>;
  return (
    <Shell title={`Careers at ${page.companyName}`}>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Careers at {page.companyName}</h1>
      {page.intro && <p className="text-sm text-label-secondary whitespace-pre-wrap mb-6">{page.intro}</p>}
      {page.jobs.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary mt-6">There are no open positions right now. Please check again soon.</div>
      ) : (
        <ul className="space-y-3 mt-6" aria-label="Open positions">
          {page.jobs.map((j) => (
            <li key={j.id}>
              <Link to={`/careers/${slug}/${j.id}`} className="block bg-card rounded-card shadow-sm p-4 hover:shadow-md transition-shadow">
                <span className="block text-base font-semibold mb-1">{j.title}</span>
                <JobMeta job={j} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** One job and its application form. */
export function CareersJobPage() {
  const { slug = "", jobId = "" } = useParams();
  const [job, setJob] = useState<(CareersJobView & { companyName: string }) | null>(null);
  const [missing, setMissing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", currentEmployer: "", currentDesignation: "", expectedSalary: "", noticePeriodDays: "", coverNote: "", website: "" });
  const [resume, setResume] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    api.getPublicCareersJob(slug, jobId).then(setJob).catch(() => setMissing(true));
  }, [slug, jobId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (resume && resume.size > 5 * 1024 * 1024) { setError("Your resume is larger than 5 MB. Please upload a smaller file."); return; }
    setBusy(true);
    try {
      await api.applyToJob(slug, jobId, { ...f, consent: consent ? "true" : "false" }, resume);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We could not send your application. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <NotFound what="This job is no longer open" />;
  if (!job) return <Shell title="Careers"><p className="text-sm text-label-tertiary text-center">Loading…</p></Shell>;

  return (
    <Shell title={`${job.title} at ${job.companyName}`}>
      <Link to={`/careers/${slug}`} className="text-xs text-accent hover:underline">All open positions at {job.companyName}</Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-1">{job.title}</h1>
      <JobMeta job={job} />
      {job.description && <p className="text-sm whitespace-pre-wrap mt-5">{job.description}</p>}

      <div className="bg-card rounded-card shadow-sm p-5 mt-8">
        {done ? (
          <div role="status">
            <h2 className="text-lg font-semibold mb-1">Application received</h2>
            <p className="text-sm text-label-secondary">Thank you, {f.firstName}. We have your application for {job.title}. If your profile matches, our team will contact you.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" aria-label="Apply for this job">
            <h2 className="text-lg font-semibold">Apply for this job</h2>
            {error && <div role="alert" className="text-sm text-red-700 bg-red-50 rounded p-3">{error}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-first">First name</label><input id="ap-first" required maxLength={80} className={inputCls} value={f.firstName} onChange={set("firstName")} autoComplete="given-name" /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-last">Last name</label><input id="ap-last" required maxLength={80} className={inputCls} value={f.lastName} onChange={set("lastName")} autoComplete="family-name" /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-email">E-mail</label><input id="ap-email" type="email" required className={inputCls} value={f.email} onChange={set("email")} autoComplete="email" /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-phone">Phone</label><input id="ap-phone" type="tel" className={inputCls} value={f.phone} onChange={set("phone")} autoComplete="tel" /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-emp">Current employer</label><input id="ap-emp" className={inputCls} value={f.currentEmployer} onChange={set("currentEmployer")} /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-des">Current designation</label><input id="ap-des" className={inputCls} value={f.currentDesignation} onChange={set("currentDesignation")} /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-sal">Expected monthly salary (PKR)</label><input id="ap-sal" inputMode="numeric" className={inputCls} value={f.expectedSalary} onChange={set("expectedSalary")} /></div>
              <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-notice">Notice period (days)</label><input id="ap-notice" inputMode="numeric" className={inputCls} value={f.noticePeriodDays} onChange={set("noticePeriodDays")} /></div>
            </div>
            <div><label className="block text-xs font-semibold mb-1" htmlFor="ap-note">Anything you would like us to know</label><textarea id="ap-note" rows={4} maxLength={3000} className={inputCls} value={f.coverNote} onChange={set("coverNote")} /></div>
            <div>
              <label className="block text-xs font-semibold mb-1" htmlFor="ap-resume">Resume (PDF, DOC or DOCX, up to 5 MB)</label>
              <input id="ap-resume" type="file" accept=".pdf,.doc,.docx,application/pdf" onChange={(e) => setResume(e.target.files?.[0] ?? null)} className="text-sm" />
            </div>
            {/* Honeypot: people never see or fill this; a bot that does is silently ignored. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <label htmlFor="ap-website">Website</label>
              <input id="ap-website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I agree to {job.companyName} keeping my details to consider my application.</span>
            </label>
            <button type="submit" disabled={busy || !consent} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? "Sending…" : "Submit application"}</button>
          </form>
        )}
      </div>
    </Shell>
  );
}
