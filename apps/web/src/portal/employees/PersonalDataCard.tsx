import { useMemo, useState } from "react";
import { Eye, EyeOff, History } from "lucide-react";
import type { EmployeeView, MyPersonalDataView } from "@aihxm/shared-types";
import { formatDay } from "../shared/dates";
import { buildGroups, buildSlices, completeness, maskId, sliceTitle, type PersonalRow } from "./personalData";

/**
 * The "Personal data" card of My Profile, laid out like SAP's My Personal Data app: a dated slice ("Valid from ...")
 * with the facts grouped as Name, Birth data, Marital status and Identification, labels on the left of each value.
 * Earlier slices can be opened to see what was recorded before a change (a new surname after marriage, say).
 * ID numbers stay hidden behind "Show" until the person asks.
 */

function Value({ row }: { row: PersonalRow }) {
  const [shown, setShown] = useState(false);
  if (!row.masked) {
    return (
      <dd data-testid={`pd-${row.key}`} className={`text-sm ${row.value === "—" ? "text-label-tertiary" : ""}`}>
        {row.value}
      </dd>
    );
  }
  return (
    <dd data-testid={`pd-${row.key}`} className="text-sm flex items-center gap-2 min-w-0">
      <span className="font-mono tracking-tight truncate">{shown ? row.value : maskId(row.value)}</span>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={`${shown ? "Hide" : "Show"} ${row.label}`}
        aria-pressed={shown}
        className="text-label-tertiary hover:text-label-primary shrink-0"
      >
        {shown ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
      </button>
    </dd>
  );
}

/** `hrView`: HR maintaining someone else's record, so the "ask HR" hint reads differently. */
export function PersonalDataCard({ employee, data, hrView }: { employee: EmployeeView; data: MyPersonalDataView | null; hrView?: boolean }) {
  const slices = useMemo(() => buildSlices(data, employee), [data, employee]);
  const [selected, setSelected] = useState<string | null>(null);
  const slice = slices.find((s) => s.key === selected) ?? slices.find((s) => s.current) ?? slices[0];
  const groups = useMemo(() => buildGroups(slice, employee, data), [slice, employee, data]);
  const { filled, total } = completeness(groups);

  return (
    <div data-testid="personal-data">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold" data-testid="pd-slice-title">
            {sliceTitle(slice)}
          </h2>
          {slice.current && (
            <p className="text-xs text-label-tertiary mt-0.5" data-testid="pd-completeness">
              {filled} of {total} details filled in
              {filled < total ? (hrView ? " — use Edit to add the rest." : " — ask HR to add the rest.") : "."}
            </p>
          )}
          {slice.upcoming && (
            <p className="text-xs text-label-tertiary mt-0.5" data-testid="pd-upcoming">
              Not in force yet — takes effect on {formatDay(slice.validFrom)}.
            </p>
          )}
          {!slice.current && !slice.upcoming && <p className="text-xs text-label-tertiary mt-0.5">An earlier record. Nothing here can be changed.</p>}
        </div>
        {slices.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-label-secondary">
            <History size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Show record</span>
            <select
              id="pd-slice"
              value={slice.key}
              onChange={(e) => setSelected(e.target.value)}
              className="border border-black/10 rounded-lg bg-card px-2 py-1.5 text-sm text-label-primary"
              data-testid="pd-slice-select"
            >
              {slices.map((s) => (
                <option key={s.key} value={s.key}>
                  {sliceTitle(s)}
                  {s.current ? " (current)" : s.upcoming ? " (upcoming)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
        {groups.map((group) => (
          <section key={group.key} data-testid={`pd-group-${group.key}`} aria-labelledby={`pd-h-${group.key}`}>
            <h3 id={`pd-h-${group.key}`} className="text-xs font-semibold uppercase tracking-wide text-label-tertiary pb-1.5 mb-2 border-b border-black/10">
              {group.title}
            </h3>
            <dl className="space-y-2">
              {group.rows.map((row) => (
                <div key={row.key} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-4 items-baseline">
                  <dt className="text-sm text-label-secondary sm:text-right">{row.label}</dt>
                  <Value key={`${slice.key}-${row.key}`} row={row} />
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
