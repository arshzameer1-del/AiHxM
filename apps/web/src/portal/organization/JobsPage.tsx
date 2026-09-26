import { FormEvent, useEffect, useState } from "react";
import type { JobFamily, JobView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const JOB_FAMILY_LABELS: Record<JobFamily, string> = {
  engineering: "Engineering",
  sales: "Sales",
  marketing: "Marketing",
  finance: "Finance",
  hr: "HR",
  operations: "Operations",
  legal: "Legal",
  customer_support: "Customer Support",
  product: "Product",
  administration: "Administration",
  executive: "Executive",
  other: "Other",
};
const JOB_FAMILIES = Object.keys(JOB_FAMILY_LABELS) as JobFamily[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong.";
}

function statusBadgeClass(status: JobView["status"]): string {
  return status === "archived" ? "bg-black/10 text-label-tertiary" : "bg-success/15 text-green-700";
}

type JobFormValue = {
  title: string;
  jobCode: string;
  jobFamily: JobFamily | "";
  jobLevel: string;
  description: string;
};

const EMPTY_FORM: JobFormValue = { title: "", jobCode: "", jobFamily: "", jobLevel: "", description: "" };

function JobForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: JobView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<JobFormValue>(
    initial
      ? {
          title: initial.title,
          jobCode: initial.jobCode ?? "",
          jobFamily: initial.jobFamily ?? "",
          jobLevel: initial.jobLevel ?? "",
          description: initial.description ?? "",
        }
      : EMPTY_FORM
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        title: value.title,
        jobCode: value.jobCode || undefined,
        jobFamily: value.jobFamily || undefined,
        jobLevel: value.jobLevel || undefined,
        description: value.description || undefined,
      };
      if (initial) {
        await api.updateJob(initial.id, payload);
      } else {
        await api.createJob(payload);
      }
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">{initial ? `Editing "${initial.title}"` : "New job"}</div>
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Title</label>
          <input
            required
            autoFocus={!initial}
            value={value.title}
            onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Job Family</label>
          <select
            value={value.jobFamily}
            onChange={(e) => setValue((v) => ({ ...v, jobFamily: e.target.value as JobFamily | "" }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">—</option>
            {JOB_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {JOB_FAMILY_LABELS[f]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Level (optional)</label>
          <input
            value={value.jobLevel}
            onChange={(e) => setValue((v) => ({ ...v, jobLevel: e.target.value }))}
            placeholder="e.g. L4"
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Code (optional)</label>
          <input
            value={value.jobCode}
            onChange={(e) => setValue((v) => ({ ...v, jobCode: e.target.value }))}
            placeholder="e.g. ENG-2"
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="col-span-3">
          <label className="block text-xs font-medium mb-1">Description (optional)</label>
          <input
            value={value.description}
            onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function JobRow({ job, canManage, onChanged }: { job: JobView; canManage: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState<"none" | "edit">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      if (job.status === "active") {
        await api.archiveJob(job.id);
      } else {
        await api.activateJob(job.id);
      }
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 py-2.5 border-b border-black/5 hover:bg-black/[0.02]">
        <span className="font-medium text-sm">{job.title}</span>
        {job.jobFamily && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">
            {JOB_FAMILY_LABELS[job.jobFamily]}
          </span>
        )}
        {job.jobLevel && <span className="text-xs text-label-tertiary">{job.jobLevel}</span>}
        {job.jobCode && <span className="text-xs font-mono text-label-tertiary">{job.jobCode}</span>}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(job.status)}`}>
          {job.status}
        </span>

        {canManage && (
          <div className="ml-auto flex gap-3 shrink-0 text-xs">
            <button onClick={() => setMode(mode === "edit" ? "none" : "edit")} className="font-semibold text-accent hover:underline">
              Edit
            </button>
            <button onClick={handleToggleStatus} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
              {job.status === "active" ? "Archive" : "Activate"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-xs text-danger py-1">{error}</div>}

      {mode === "edit" && (
        <div className="py-2">
          <JobForm
            initial={job}
            onCancel={() => setMode("none")}
            onSaved={() => {
              setMode("none");
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Organization Management, Phase 2 — the Job Catalog's setup screen. A
 * plain flat list (no hierarchy — Job deliberately has none, see
 * jobs.service.ts's own class doc comment), matching OrgHierarchyPage's
 * polish level: `job.manage.all` is hr_admin-only server-side (0069's
 * seed); `canManage` here mirrors that as a courtesy, same as every other
 * portal screen — the real gate is JobsService's own RBAC check. This is
 * also the screen Configuration Center's Job Catalog card deep-links to
 * (0070_configuration_center_job.sql's `admin_route`).
 */
export function JobsPage() {
  const { identity } = useAuth();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    api
      .listJobs()
      .then(setJobs)
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!jobs) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Job Catalog</h1>
          <p className="text-sm text-label-tertiary mt-1">
            Reusable job titles, families, and levels — define one here and reference it from as many positions as you like.
          </p>
        </div>
        {canManage && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Job
          </button>
        )}
      </div>

      {creating && (
        <div className="mb-4">
          <JobForm
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {jobs.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No jobs yet. {canManage ? "Create the first one above." : "Ask an HR Admin to set up the job catalog."}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} canManage={canManage} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
