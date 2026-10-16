import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Pencil, XCircle } from "lucide-react";
import type { HolidayView, LeaveRequestView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader, LoadingNote } from "../shared/PageChrome";
import { RequestDetail } from "./LeaveOverview";

/** One request on its own page: header, fields, approval chain and the Team calendar, with Edit and Cancel. */
export function LeaveDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { employeeId: ownEmployeeId, canSubmitSelf, canSubmitOnBehalf, bump } = useModuleContext();
  const [request, setRequest] = useState<LeaveRequestView | null>(null);
  const [holidayList, setHolidayList] = useState<HolidayView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.getLeaveRequest(id).then(setRequest).catch((err) => setError(err instanceof ApiError && err.status === 404 ? "This request does not exist or you cannot see it." : "This request could not be loaded."));
  }, [id]);

  useEffect(() => {
    const y = new Date().getUTCFullYear();
    Promise.all([api.listHolidays(String(y)), api.listHolidays(String(y + 1))]).then(([a, b]) => setHolidayList([...a, ...b])).catch(() => undefined);
  }, []);
  const holidays = useMemo(() => new Map(holidayList.filter((h) => !h.isOptional).map((h) => [h.holidayDate.slice(0, 10), h.name])), [holidayList]);

  const onBehalfId = params.get("employee");
  const backTo = onBehalfId ? `/app/leave/on-behalf/${onBehalfId}` : request && request.employeeId !== ownEmployeeId && canSubmitOnBehalf ? `/app/leave/on-behalf/${request.employeeId}` : "/app/leave/my-requests";

  if (error) return (<div><BackLink to="/app/leave/my-requests">Back to My Leave Request</BackLink><p className="text-sm text-label-secondary">{error}</p></div>);
  if (!request) return <LoadingNote />;

  const mine = request.employeeId === ownEmployeeId;
  const canAct = (mine && canSubmitSelf) || canSubmitOnBehalf;
  const cancellationRequested = request.status === "approved" && request.cancellationStatus === "requested";
  const canWithdraw = canAct && (request.status === "pending" || request.status === "approved") && !cancellationRequested;

  async function withdraw() {
    if (!request) return;
    setError(null);
    setBusy(true);
    try {
      if (request.status === "pending") {
        if (!window.confirm("Do you really want to cancel this request?")) return;
        await api.cancelLeaveRequest(request.id);
      } else {
        const reason = window.prompt("Why does this approved leave need to be cancelled?");
        if (!reason || reason.trim().length < 3) return;
        await api.requestLeaveCancellation(request.id, { reason: reason.trim() });
      }
      bump();
      setRequest(await api.getLeaveRequest(request.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change this request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <BackLink to={backTo}>Back to My Leave Request</BackLink>
      <PageHeader
        title="Request Details"
        actions={
          <>
            {canAct && request.status === "pending" && (
              <button type="button" onClick={() => navigate(`/app/leave/${request.id}/edit${onBehalfId ? `?employee=${onBehalfId}` : ""}`)} className="inline-flex items-center gap-1.5 border border-accent text-accent rounded px-3 py-1.5 text-sm font-semibold">
                <Pencil size={15} /> Edit
              </button>
            )}
            {canWithdraw && (
              <button type="button" onClick={withdraw} disabled={busy} className="inline-flex items-center gap-1.5 border border-accent text-accent rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
                <XCircle size={15} /> {request.status === "pending" ? "Cancel request" : "Request cancellation"}
              </button>
            )}
          </>
        }
      />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      <RequestDetail request={request} holidays={holidays} weekend={[0, 6]} />
    </div>
  );
}
