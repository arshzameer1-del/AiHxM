import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, useEffect, useState } from "react";
import type { AttendanceDeviceView, DeviceEnrollmentView, EmployeeView, RawPunchView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Leave module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage attendance devices.";
    return err.message;
  }
  return "Something went wrong.";
}

const PUNCH_STYLES: Record<RawPunchView["status"], string> = {
  received: "bg-black/5 text-label-secondary",
  processed: "bg-success/10 text-success",
  duplicate: "bg-black/5 text-label-secondary",
  unmatched: "bg-warning/10 text-warning",
  rejected: "bg-danger/10 text-danger",
};

/**
 * TLM-05 - biometric / face / card / kiosk devices. A device posts punches to the ingestion
 * endpoint with its own key (shown once here); each device user id is enrolled against an employee.
 * Punches from a user nobody has enrolled wait as "unmatched" and are processed on enrolment.
 */
export function AttendanceDevicesPanel() {
  const [devices, setDevices] = useState<AttendanceDeviceView[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [shownKey, setShownKey] = useState<{ deviceName: string; apiKey: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<DeviceEnrollmentView[]>([]);
  const [punches, setPunches] = useState<RawPunchView[]>([]);
  const [enrollForm, setEnrollForm] = useState({ employeeId: "", deviceUserId: "" });
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api.listAttendanceDevices().then(setDevices).catch((err) => setError(describeError(err)));
  }
  useEffect(() => {
    load();
    api.listEmployees().then(setEmployees).catch(() => undefined);
  }, []);

  function openDevice(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setNote(null);
    Promise.all([api.listDeviceEnrollments(id), api.listAttendancePunches({ deviceId: id, limit: 20 })])
      .then(([en, p]) => {
        setEnrollments(en);
        setPunches(p);
      })
      .catch((err) => setError(describeError(err)));
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createAttendanceDevice({ name, serialNumber: serial || undefined });
      setShownKey({ deviceName: created.name, apiKey: created.apiKey });
      setCreating(false);
      setName("");
      setSerial("");
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function rotate(d: AttendanceDeviceView) {
    if (!window.confirm(`Issue a new key for ${d.name}? The device stops working until it is given the new key.`)) return;
    try {
      const r = await api.rotateAttendanceDeviceKey(d.id);
      setShownKey({ deviceName: r.name, apiKey: r.apiKey });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function toggle(d: AttendanceDeviceView) {
    try {
      await api.updateAttendanceDevice(d.id, { isActive: !d.isActive });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function enroll(e: FormEvent) {
    e.preventDefault();
    if (!openId) return;
    setError(null);
    try {
      const r = await api.enrollDeviceUser(openId, enrollForm);
      setNote(r.reprocessed > 0 ? `Enrolled. ${r.reprocessed} waiting punch${r.reprocessed === 1 ? "" : "es"} processed.` : "Enrolled.");
      setEnrollForm({ employeeId: "", deviceUserId: "" });
      load();
      const [en, p] = await Promise.all([api.listDeviceEnrollments(openId), api.listAttendancePunches({ deviceId: openId, limit: 20 })]);
      setEnrollments(en);
      setPunches(p);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function revoke(enrollmentId: string) {
    if (!openId) return;
    try {
      await api.revokeDeviceEnrollment(openId, enrollmentId);
      setEnrollments(await api.listDeviceEnrollments(openId));
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (error && !devices) return <p className="text-sm text-danger">{error}</p>;
  if (!devices) return <LoadingNote />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-label-secondary max-w-2xl">
          Attendance devices send punches to AiHxM with their own key. Enrol each device user against an employee; punches
          from anyone not enrolled are kept and processed as soon as they are.
        </p>
        <button onClick={() => setCreating((v) => !v)} className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold shrink-0">
          {creating ? "Close" : "Add device"}
        </button>
      </div>

      {shownKey && (
        <div className="bg-warning/10 rounded-lg p-4 text-sm">
          <div className="font-semibold mb-1">Key for {shownKey.deviceName} — copy it now, it is not shown again</div>
          <code className="block font-mono text-xs break-all bg-white/60 rounded px-2 py-1.5">{shownKey.apiKey}</code>
          <p className="text-xs text-label-secondary mt-2">
            The device sends it in the <code>x-device-key</code> header when it posts to <code>/device-ingest/&lt;device id&gt;/punches</code>.
          </p>
          <button onClick={() => setShownKey(null)} className="mt-2 text-xs font-semibold text-accent">I have saved it</button>
        </div>
      )}

      {creating && (
        <form onSubmit={create} className="bg-black/5 rounded-lg p-4 grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="ad-name" className="block text-sm font-medium mb-1">Device name</label>
            <input id="ad-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Main gate"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </div>
          <div>
            <label htmlFor="ad-serial" className="block text-sm font-medium mb-1">Serial number (optional)</label>
            <input id="ad-serial" value={serial} onChange={(e) => setSerial(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
          </div>
          <div className="col-span-2"><button type="submit" className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">Create device</button></div>
        </form>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-label-tertiary">No devices yet.</p>
      ) : (
        <div className="bg-card rounded-card shadow-sm divide-y divide-black/5">
          {devices.map((d) => (
            <div key={d.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <button onClick={() => openDevice(d.id)} className="text-left min-w-0">
                  <div className="font-medium text-sm">{d.name} <span className="text-xs text-label-tertiary ml-1">{d.deviceType}</span></div>
                  <div className="text-xs text-label-secondary mt-1">
                    {d.enrolledCount} enrolled · {d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : "never connected"}
                    {d.apiKeyPrefix && ` · key ${d.apiKeyPrefix}…`}
                  </div>
                </button>
                <div className="flex items-center gap-3 shrink-0 text-xs font-semibold">
                  <button onClick={() => rotate(d)} className="text-accent">New key</button>
                  <button onClick={() => toggle(d)} className={d.isActive ? "text-danger" : "text-accent"}>{d.isActive ? "Switch off" : "Switch on"}</button>
                </div>
              </div>
              {openId === d.id && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-label-tertiary font-semibold mb-2">Enrolled users</h4>
                    {note && <p className="text-xs text-success mb-2">{note}</p>}
                    <ul className="text-sm divide-y divide-black/5 mb-3">
                      {enrollments.filter((en) => en.status === "active").map((en) => (
                        <li key={en.id} className="py-1.5 flex justify-between gap-2">
                          <span>{en.employeeName} <span className="text-label-tertiary text-xs">device id {en.deviceUserId}</span></span>
                          <button onClick={() => revoke(en.id)} className="text-xs font-semibold text-danger">Remove</button>
                        </li>
                      ))}
                      {enrollments.every((en) => en.status !== "active") && <li className="py-1.5 text-label-tertiary text-xs">Nobody enrolled.</li>}
                    </ul>
                    <form onSubmit={enroll} className="flex gap-2 flex-wrap items-end">
                      <div>
                        <label htmlFor="en-emp" className="block text-xs mb-1">Employee</label>
                        <select id="en-emp" required value={enrollForm.employeeId} onChange={(e) => setEnrollForm({ ...enrollForm, employeeId: e.target.value })}
                          className="rounded-lg border border-black/10 px-2 py-1.5 text-sm">
                          <option value="">Choose…</option>
                          {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName}</option>)}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="en-id" className="block text-xs mb-1">Device user id</label>
                        <input id="en-id" required value={enrollForm.deviceUserId} onChange={(e) => setEnrollForm({ ...enrollForm, deviceUserId: e.target.value })}
                          className="w-28 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
                      </div>
                      <button type="submit" className="bg-accent text-white rounded-lg px-3 py-1.5 text-sm font-semibold">Enrol</button>
                    </form>
                  </div>
                  <div>
                    <h4 className="text-xs uppercase tracking-wide text-label-tertiary font-semibold mb-2">Latest punches</h4>
                    <ul className="text-xs divide-y divide-black/5">
                      {punches.map((p) => (
                        <li key={p.id} className="py-1.5 flex justify-between gap-2">
                          <span className="tabular-nums">{new Date(p.punchedAt).toLocaleString()} · id {p.deviceUserId} · {p.direction}</span>
                          <span title={p.error ?? ""} className={`px-2 py-0.5 rounded-full font-semibold ${PUNCH_STYLES[p.status]}`}>{p.status}</span>
                        </li>
                      ))}
                      {punches.length === 0 && <li className="py-1.5 text-label-tertiary">No punches received yet.</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
