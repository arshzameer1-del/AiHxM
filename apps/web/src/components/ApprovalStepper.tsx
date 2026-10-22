/**
 * A row of steps with dots on a line (the One exD approval stepper). Steps before `current` are done, `current` is the open
 * step, later steps are waiting. `failed` marks the current step as stopped (rejected / cancelled).
 */
export function ApprovalStepper({ steps, current, failed = false, title }: { steps: string[]; current: number; failed?: boolean; title?: string }) {
  return (
    <ol className="approval-stepper" aria-label={title ?? "Approval progress"}>
      {steps.map((label, index) => {
        const state = index < current ? "done" : index === current ? (failed ? "failed" : "current") : "todo";
        return (
          <li key={label} className={`approval-step is-${state}`} aria-current={state === "current" || state === "failed" ? "step" : undefined}>
            <span className="approval-dot" aria-hidden="true" />
            <span className="approval-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
