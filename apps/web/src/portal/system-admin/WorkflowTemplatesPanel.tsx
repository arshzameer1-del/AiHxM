import { useEffect, useState } from "react";
import type { WorkflowApproverConfig, WorkflowApproverOptions, WorkflowStepConfig, WorkflowTemplate } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { WorkflowTemplateForm } from "./WorkflowTemplateForm";
import { WorkflowSimulator } from "./WorkflowSimulator";
import { WorkflowHistory } from "./WorkflowHistory";
import { describeCondition } from "./workflowConditions";
import { APPROVER_TYPE_LABELS, ESCALATION_LABELS, FALLBACK_LABELS, FIXED_KEY_WORKFLOWS, KNOWN_WORKFLOWS, type KnownWorkflow } from "./workflowTemplateOptions";

const GROUPS = ["Time and leave", "Pay", "Hiring and organisation", "Privacy"] as const;

function approverText(a: WorkflowApproverConfig, options: WorkflowApproverOptions): string {
  switch (a.approverType) {
    case "role":
      return options.roles.find((r) => r.id === a.roleId)?.name ?? "an unknown role";
    case "specific_user":
      return options.people.find((p) => p.userAccountId === a.userAccountId)?.fullName ?? "a specific person";
    case "position":
      return `whoever holds ${options.positions.find((p) => p.id === a.positionId)?.title ?? "a position"}`;
    case "group":
      return `a member of ${options.groups.find((g) => g.id === a.employeeGroupId)?.name ?? "an employee group"}`;
    case "org_unit_head":
      return a.orgUnitId ? `the head of ${options.orgUnits.find((u) => u.id === a.orgUnitId)?.name ?? "a unit"}` : "the head of the requester's unit";
    default:
      return APPROVER_TYPE_LABELS[a.approverType].replace(/^The /, "the ");
  }
}

function stepSummary(step: WorkflowStepConfig, options: WorkflowApproverOptions, workflow: KnownWorkflow): string {
  const labelOf = (field: string) => workflow.fields.find((f) => f.key === field)?.label ?? field;
  const approvers = step.approvers.map((a) => approverText(a, options));
  const joiner = step.approvalMode === "any" ? " OR " : " AND ";
  const comments = [step.requireCommentOnApprove ? "approve" : "", step.requireCommentOnReject ? "reject" : ""].filter(Boolean).join(" and ");
  const extras: string[] = [];
  if (step.approvalMode === "quorum") extras.push(`${step.quorumCount} of ${step.approvers.length} must approve`);
  if (step.reminderHours) extras.push(`reminder every ${step.reminderHours}h`);
  if (step.parallelGroup) extras.push(`at the same time as other "${step.parallelGroup}" steps`);
  if (step.condition) extras.push(`only when ${describeCondition(step.condition, labelOf)}`);
  const fallbacks = step.approvers.filter((a) => a.fallbackType).map((a) => `if no ${APPROVER_TYPE_LABELS[a.approverType].replace(/^The requester's /, "").toLowerCase()} is found: ${FALLBACK_LABELS[a.fallbackType!].toLowerCase()}`);
  extras.push(...fallbacks);
  const escalations = step.approvers.filter((a) => a.escalationApproverType).map((a) => `escalates to ${ESCALATION_LABELS[a.escalationApproverType!].toLowerCase()}`);
  extras.push(...escalations);
  const autos = step.approvers.filter((a) => a.escalationAction).map((a) => `${a.escalationAction === "auto_approve" ? "approved" : "rejected"} automatically ${a.escalationActionHours}h after escalation`);
  extras.push(...autos);
  return `${step.name} — ${approvers.join(joiner)}${step.slaHours ? ` (SLA ${step.slaHours}h)` : ""}${comments ? ` · comment needed to ${comments}` : ""}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

export function WorkflowTemplatesPanel() {
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [options, setOptions] = useState<WorkflowApproverOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the template key being edited, or "new:<objectKey>" for an additional route */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function toggleActive(key: string, isActive: boolean) {
    setToggleError(null);
    try {
      await api.setWorkflowTemplateActive(key, isActive);
      load();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : "Could not change this workflow.");
    }
  }

  function load() {
    Promise.all([api.listWorkflowTemplates(), api.getWorkflowApproverOptions()])
      .then(([t, o]) => {
        setTemplates(t);
        setOptions(o);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load workflow templates."));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!templates || !options) return <LoadingNote />;

  const known = new Set(KNOWN_WORKFLOWS.map((w) => w.objectKey));
  const other = templates.filter((t) => !known.has(t.objectKey));

  return (
    <div className="space-y-6">
      <p className="text-sm text-label-tertiary">
        Every request that needs approval follows a route set here. Processes marked "needs a route" cannot be submitted until one is configured;
        for the others, requests are decided the normal way (by the manager or HR) until you add a route. Requests already sent keep the version they started with.
      </p>

      {toggleError && <p className="text-xs text-danger">{toggleError}</p>}

      {GROUPS.map((group) => (
        <section key={group} className="space-y-4" aria-label={group}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-label-tertiary">{group}</h2>
          {KNOWN_WORKFLOWS.filter((w) => w.group === group).map((workflow) => {
            const routes = templates
              .filter((t) => t.objectKey === workflow.objectKey)
              .sort((a, b) => (a.key === workflow.key ? -1 : b.key === workflow.key ? 1 : a.createdAt.localeCompare(b.createdAt)));
            const primary = routes.find((t) => t.key === workflow.key);
            const mustHave = FIXED_KEY_WORKFLOWS.has(workflow.key);
            const nextKey = `${workflow.key}_route_${routes.length + 1}`;
            const pillFor = (t: WorkflowTemplate) => (
              <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold shrink-0 ${t.isActive ? "bg-success/15 text-green-700" : "bg-warning/15 text-warning"}`}>
                {t.isActive ? "Configured" : "Switched off"}
              </span>
            );
            return (
              <div key={workflow.key} className="bg-card rounded-card p-5 shadow-sm" data-testid={`process-${workflow.key}`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">{workflow.label}</h3>
                    <p className="text-sm text-label-tertiary mt-0.5">{workflow.description}</p>
                  </div>
                  {primary ? (
                    pillFor(primary)
                  ) : (
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary shrink-0">
                      {routes.length === 0 ? "Not configured" : "Other route only"}
                    </span>
                  )}
                </div>
                {!primary && mustHave && <p className="text-xs text-warning mt-2">This process needs a route before anyone can submit it.</p>}

                {routes.map((route) => (
                  <div key={route.key} className="mt-4 border-t border-black/5 pt-3" data-testid={`route-${route.key}`}>
                    {route.key !== workflow.key && (
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium">{route.name}</span>
                        {pillFor(route)}
                      </div>
                    )}
                    {route.startCondition && (
                      <p className="text-xs text-label-secondary mb-1">
                        Used only when {describeCondition(route.startCondition, (f) => workflow.fields.find((x) => x.key === f)?.label ?? f)}
                      </p>
                    )}
                    <ol className="space-y-1 list-decimal list-inside">
                      {route.steps.map((step) => (
                        <li key={step.stepOrder} className="text-sm text-label-secondary">
                          {stepSummary(step, options, workflow)}
                        </li>
                      ))}
                    </ol>

                    {configuring === route.key ? (
                      <div className="mt-3">
                        <WorkflowTemplateForm
                          workflow={workflow}
                          existing={route}
                          options={options}
                          onCancel={() => setConfiguring(null)}
                          onSaved={() => {
                            setConfiguring(null);
                            load();
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="mt-3 flex items-center gap-4 flex-wrap">
                          <button type="button" onClick={() => setConfiguring(route.key)} className="border border-accent text-accent rounded-lg px-4 py-2 text-sm font-semibold">
                            {route.key === workflow.key ? "Edit approvers" : "Edit route"}
                          </button>
                          <button type="button" onClick={() => toggleActive(route.key, !route.isActive)} className="text-sm font-medium text-label-secondary hover:text-accent">
                            {route.isActive ? "Switch off" : "Switch on"}
                          </button>
                          {route.currentVersionNo && <span className="text-xs text-label-tertiary">Version {route.currentVersionNo}. Requests already sent keep the version they started with.</span>}
                        </div>
                        <WorkflowSimulator workflow={workflow} template={route} options={options} />
                        <WorkflowHistory template={route} onRestored={load} />
                      </>
                    )}
                  </div>
                ))}

                {!primary && (
                  <div className="mt-3">
                    {configuring === workflow.key ? (
                      <WorkflowTemplateForm workflow={workflow} options={options} onCancel={() => setConfiguring(null)} onSaved={() => { setConfiguring(null); load(); }} />
                    ) : (
                      <button type="button" onClick={() => setConfiguring(workflow.key)} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold">
                        Configure
                      </button>
                    )}
                  </div>
                )}

                {primary && !mustHave && (
                  <div className="mt-3">
                    {configuring === `new:${workflow.key}` ? (
                      <WorkflowTemplateForm
                        workflow={{ ...workflow, key: nextKey, label: `${workflow.label} (route ${routes.length + 1})` }}
                        options={options}
                        onCancel={() => setConfiguring(null)}
                        onSaved={() => { setConfiguring(null); load(); }}
                      />
                    ) : (
                      <button type="button" onClick={() => setConfiguring(`new:${workflow.key}`)} className="text-xs font-semibold text-accent hover:underline">
                        + Add another route (for example, a different one for large amounts)
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}

      {other.length > 0 && (
        <section className="space-y-2" aria-label="Other routes">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-label-tertiary">Other routes</h2>
          {other.map((t) => (
            <div key={t.key} className="bg-card rounded-card p-4 shadow-sm text-sm text-label-secondary">
              {t.name} ({t.objectKey}) — {t.isActive ? "on" : "switched off"}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
