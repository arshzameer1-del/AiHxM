import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useFormLayout } from "../shared/useFormLayout";

/** The company's own fields (added in the Form designer) that sit on the employee form, shown read-only with their saved values. */
export function EmployeeCustomFields({ employeeId }: { employeeId: string }) {
  const layoutView = useFormLayout("employee_profile");
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const placed = new Set((layoutView?.layout?.sections ?? []).flatMap((s) => s.fields.filter((f) => f.custom).map((f) => f.key)));
  const fields = (layoutView?.customFields ?? []).filter((c) => placed.has(c.key));
  const show = fields.length > 0;
  useEffect(() => {
    if (!show) return;
    let alive = true;
    api.getCustomFieldValues("employee", employeeId).then((v) => { if (alive) setValues(v); }).catch(() => { if (alive) setValues({}); });
    return () => { alive = false; };
  }, [employeeId, show]);
  if (!show) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6" data-testid="employee-custom-fields" aria-label="Additional details">
      <h2 className="text-sm font-bold uppercase tracking-wide text-label-secondary mb-3">Additional details</h2>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {fields.map((f) => {
          const raw = values?.[f.key];
          const text = values === null ? "…" : raw === null || raw === undefined || raw === "" ? "Not recorded" : typeof raw === "boolean" ? (raw ? "Yes" : "No") : String(raw);
          return (
            <div key={f.key}>
              <dt className="text-xs text-label-tertiary">{f.label}</dt>
              <dd className="text-sm">{text}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
