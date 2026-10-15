import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { EmployeeView, LeaveRequestView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader } from "../shared/PageChrome";
import { OnBehalfBanner } from "./OnBehalfBanner";
import { LeaveRequestForm } from "./LeaveRequestForm";

/**
 * Create Request / Edit Request as their own page. Dates picked on the calendar arrive as ?start=&end=; an
 * employee other than the signed-in user arrives as ?employee= (new) or is read from the request (edit), and
 * then the on-behalf banner is shown.
 */
export function LeaveFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { employeeId: ownEmployeeId } = useModuleContext();
  const [request, setRequest] = useState<LeaveRequestView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [target, setTarget] = useState<EmployeeView | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getLeaveRequest(id).then(setRequest).catch(() => setFailed("This request could not be loaded."));
  }, [id]);

  const employeeId = id ? request?.employeeId : params.get("employee") ?? ownEmployeeId;
  const onBehalf = Boolean(employeeId && employeeId !== ownEmployeeId);

  useEffect(() => {
    if (!employeeId || !onBehalf) {
      setTarget(null);
      return;
    }
    api.getEmployee(employeeId).then(setTarget).catch(() => setTarget(null));
  }, [employeeId, onBehalf]);

  const backTo = onBehalf && employeeId ? `/app/leave/on-behalf/${employeeId}` : "/app/leave/my-requests";
  const leave = () => navigate(backTo);

  if (failed) return <p className="text-sm text-label-secondary">{failed}</p>;
  if (id && !request) return <p className="text-sm text-label-tertiary">Loading…</p>;
  if (!employeeId) return <p className="text-sm text-label-secondary">Your login has no employee record to create leave for.</p>;
  if (request && request.status !== "pending") {
    return (
      <div>
        <BackLink to={`/app/leave/${request.id}`}>Back to the request</BackLink>
        <p className="text-sm text-label-secondary">Only a pending request can be edited. This one is {request.status}.</p>
      </div>
    );
  }

  return (
    <div data-testid="leave-request-page">
      <BackLink to={backTo}>{onBehalf ? "Back to the employee's leave" : "Back to My Leave Request"}</BackLink>
      <PageHeader title={id ? "Edit Request" : "Create Request"} />
      {onBehalf && target && <OnBehalfBanner name={`${target.firstName} ${target.lastName}`} number={target.employeeNumber} stopTo="/app/leave" />}
      <LeaveRequestForm
        key={request?.id ?? "new"}
        fixedEmployeeId={employeeId}
        initialStart={params.get("start") ?? undefined}
        initialEnd={params.get("end") ?? undefined}
        editing={request ?? undefined}
        onCancel={leave}
        onSubmitted={(result) => navigate(backTo, { state: { overlapWarnings: result.overlapWarnings } })}
      />
    </div>
  );
}
