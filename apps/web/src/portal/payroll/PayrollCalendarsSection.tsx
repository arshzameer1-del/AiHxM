import { LoadingNote } from "../shared/PageChrome";
import { formatDay, formatPeriod } from "../shared/dates";
import { FormEvent, useCallback, useEffect, useState } from "react";
import type { PayrollCalendarView, PayrollFrequency, PayrollPeriodStatus, PayrollPeriodView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-xs font-medium mb-1";

export const FREQUENCY_LABELS: Record<PayrollFrequency, string> = {
  monthly: "Monthly",
  semi_monthly: "Semi-monthly",
  bi_weekly: "Bi-weekly",
  weekly: "Weekly",
};

const PERIOD_STATUS_STYLES: Record<PayrollPeriodStatus, string> = {
  open: "bg-success/15 text-green-700",
  locked: "bg-amber-100 text-amber-800",
  closed: "bg-black/10 text-label-secondary",
};

const message = (err: unknown, fallback: string) => (err instanceof ApiError && err.message ? err.message : fallback);

/**
 * PAY-03. Payroll calendars (how often, which currency, how pay date and cut-off follow the period end) and the
 * periods generated from them. A period is open (any run), locked (off-cycle runs only) or closed.
 * The server enforces every rule; the buttons only mirror it.
 */
export function PayrollCalendarsSection({ canManage }: { canManage: boolean }) {
  const [calendars, setCalendars] = useState<PayrollCalendarView[] | null>(null);
  const [periods, setPeriods] = useState<PayrollPeriodView[]>([]);
  const [calendarId, setCalendarId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState<PayrollFrequency>("monthly");
  const [payDayOffset, setPayDayOffset] = useState("0");
  const [cutoff, setCutoff] = useState("0");

  const [fromDate, setFromDate] = useState("");
  const [count, setCount] = useState("12");
  const [reopenFor, setReopenFor] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState("");

  const load = useCallback(async () => {
    try {
      const cals = await api.listPayrollCalendars(true);
      setCalendars(cals);
      setPeriods(await api.listPayrollPeriods(calendarId ? { calendarId } : {}));
      setError(null);
    } catch (err) {
      setError(message(err, "Could not load payroll calendars."));
    }
  }, [calendarId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const createCalendar = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const cal = await api.createPayrollCalendar({
        code: code.trim(),
        name: name.trim(),
        frequency,
        payDayOffset: Number(payDayOffset),
        cutoffDaysBeforeEnd: Number(cutoff),
      });
      setShowCreate(false);
      setCode("");
      setName("");
      setCalendarId(cal.id);
    }, "Could not create this calendar.");
  };

  const generate = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const res = await api.generatePayrollPeriods(calendarId, { fromDate, count: Number(count) });
      setNotice(`${res.created.length} period(s) created${res.skipped.length ? `, ${res.skipped.length} skipped (${res.skipped[0].reason})` : ""}.`);
    }, "Could not generate periods.");
  };

  const selected = calendars?.find((c) => c.id === calendarId);

  return (
    <div className="space-y-4">
      {error && <div className="text-danger text-xs">{error}</div>}
      {notice && <div className="text-xs text-label-secondary">{notice}</div>}

      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-[14rem]">
          <label className={labelClass} htmlFor="calendar-filter">
            Calendar
          </label>
          <select id="calendar-filter" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className={inputClass}>
            <option value="">All calendars</option>
            {(calendars ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code}) — {FREQUENCY_LABELS[c.frequency]}
                {c.isActive ? "" : " · inactive"}
              </option>
            ))}
          </select>
        </div>
        {canManage && (
          <button onClick={() => setShowCreate((v) => !v)} className="text-xs font-semibold text-accent hover:underline">
            {showCreate ? "Cancel" : "New calendar"}
          </button>
        )}
      </div>

      {showCreate && canManage && (
        <form onSubmit={createCalendar} className="grid grid-cols-2 md:grid-cols-5 gap-3 bg-black/5 rounded-lg p-4">
          <div>
            <label className={labelClass} htmlFor="cal-code">Code</label>
            <input id="cal-code" required maxLength={50} value={code} onChange={(e) => setCode(e.target.value)} className={inputClass} />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="cal-name">Name</label>
            <input id="cal-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="cal-freq">Frequency</label>
            <select id="cal-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as PayrollFrequency)} className={inputClass}>
              {(Object.keys(FREQUENCY_LABELS) as PayrollFrequency[]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="cal-pay">Pay date (days after period end)</label>
            <input id="cal-pay" type="number" min={-31} max={62} value={payDayOffset} onChange={(e) => setPayDayOffset(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="cal-cutoff">Input cut-off (days before end)</label>
            <input id="cal-cutoff" type="number" min={0} max={31} value={cutoff} onChange={(e) => setCutoff(e.target.value)} className={inputClass} />
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={busy || !code.trim() || !name.trim()} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
              Create calendar
            </button>
          </div>
        </form>
      )}

      {canManage && selected && (
        <form onSubmit={generate} className="flex items-end gap-3 flex-wrap bg-black/5 rounded-lg p-4">
          <div>
            <label className={labelClass} htmlFor="gen-from">First period starts on</label>
            <input id="gen-from" type="date" required value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="gen-count">How many periods</label>
            <input id="gen-count" type="number" min={1} max={60} required value={count} onChange={(e) => setCount(e.target.value)} className={inputClass} />
          </div>
          <button type="submit" disabled={busy || !fromDate} className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
            Generate for {selected.code}
          </button>
          <span className="text-xs text-label-tertiary">
            {selected.frequency === "monthly" ? "Start on the 1st." : selected.frequency === "semi_monthly" ? "Start on the 1st or the 16th." : ""}
          </span>
        </form>
      )}

      {!calendars ? (
        <LoadingNote />
      ) : periods.length === 0 ? (
        <div className="text-sm text-label-tertiary">No payroll periods yet{canManage ? " — pick a calendar and generate some." : "."}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-label-tertiary">
                <th className="py-1 pr-4 font-medium">Period</th>
                <th className="py-1 pr-4 font-medium">Dates</th>
                <th className="py-1 pr-4 font-medium">Inputs due</th>
                <th className="py-1 pr-4 font-medium">Pay date</th>
                <th className="py-1 pr-4 font-medium">Runs</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                {canManage && <th className="py-1 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {periods.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{p.label}</div>
                    <div className="text-xs text-label-tertiary">{p.calendarCode}</div>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {formatPeriod(p.periodStart, p.periodEnd)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{formatDay(p.cutoffDate)}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{formatDay(p.payDate)}</td>
                  <td className="py-2 pr-4">{p.runCount}</td>
                  <td className="py-2 pr-4">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${PERIOD_STATUS_STYLES[p.status]}`}>{p.status}</span>
                  </td>
                  {canManage && (
                    <td className="py-2 text-xs space-x-3 whitespace-nowrap">
                      {p.status === "open" && (
                        <button disabled={busy} onClick={() => act(async () => void (await api.lockPayrollPeriod(p.id)), "Could not lock this period.")} className="font-semibold text-amber-800 hover:underline">
                          Lock
                        </button>
                      )}
                      {p.status === "locked" && (
                        <button disabled={busy} onClick={() => act(async () => void (await api.unlockPayrollPeriod(p.id)), "Could not unlock this period.")} className="font-semibold text-accent hover:underline">
                          Unlock
                        </button>
                      )}
                      {p.status !== "closed" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm(`Close ${p.label}? No further runs can be created for it.`)) return;
                            void act(async () => void (await api.closePayrollPeriod(p.id)), "Could not close this period.");
                          }}
                          className="font-semibold text-success hover:underline"
                        >
                          Close
                        </button>
                      )}
                      {p.status === "closed" && reopenFor !== p.id && (
                        <button onClick={() => setReopenFor(p.id)} className="font-semibold text-amber-800 hover:underline">
                          Reopen…
                        </button>
                      )}
                      {reopenFor === p.id && (
                        <span className="inline-flex items-center gap-2">
                          <input
                            id={`reopen-${p.id}`}
                            value={reopenReason}
                            onChange={(e) => setReopenReason(e.target.value)}
                            placeholder="Reason (min 5 characters)"
                            className="border border-black/10 rounded-lg px-2 py-1 text-xs bg-card"
                          />
                          <button
                            disabled={busy || reopenReason.trim().length < 5}
                            onClick={() =>
                              act(async () => {
                                await api.reopenPayrollPeriod(p.id, reopenReason.trim());
                                setReopenFor(null);
                                setReopenReason("");
                              }, "Could not reopen this period.")
                            }
                            className="font-semibold text-accent disabled:opacity-50"
                          >
                            Confirm
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
