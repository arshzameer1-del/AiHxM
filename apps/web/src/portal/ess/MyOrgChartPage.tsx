import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MyOrgChart, MyOrgChartNode, MyOrgChartPerson } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, PageHeader } from "../shared/PageChrome";

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function countAll(nodes: MyOrgChartNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countAll(x.directReports), 0);
}

function PersonCard({ person, highlight, testId, extra }: { person: MyOrgChartPerson; highlight?: boolean; testId?: string; extra?: string }) {
  return (
    <div
      data-testid={testId}
      className={`flex items-center gap-3 rounded-md p-3 min-w-0 ${highlight ? "bg-accent/10 ring-1 ring-accent" : "bg-white shadow-sm"}`}
    >
      <div className="h-10 w-10 shrink-0 rounded-full bg-accent/15 text-accent grid place-items-center text-sm font-semibold" aria-hidden="true">
        {initials(person.fullName)}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold truncate">
          {person.fullName}
          {highlight && <span className="ml-2 text-xs font-medium text-accent">You</span>}
        </p>
        <p className="text-xs text-label-secondary truncate">{person.designation ?? "—"}</p>
        <p className="text-xs text-label-tertiary truncate">{[person.department, extra].filter(Boolean).join(" · ") || "—"}</p>
      </div>
    </div>
  );
}

function TeamNode({ node, depth }: { node: MyOrgChartNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const has = node.directReports.length > 0;
  return (
    <li>
      <div className="flex items-start gap-1">
        {has ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.fullName}'s team`}
            className="mt-3 h-6 w-6 shrink-0 grid place-items-center rounded text-label-secondary hover:bg-black/5"
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" aria-hidden="true" />
        )}
        <div className="flex-1 min-w-0 max-w-md">
          <PersonCard person={node} extra={has ? `${countAll(node.directReports)} in team` : undefined} testId="org-report" />
        </div>
      </div>
      {has && open && (
        <ul className="ml-4 pl-4 border-l border-black/10 mt-2 space-y-2">
          {node.directReports.map((c) => (
            <TeamNode key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * "My Org Chart" (Employee Self Service): where the signed-in person sits. Their manager chain, their colleagues under
 * the same manager and everyone below them — across departments, so a manager sees all of their own teams. Only public
 * fields (name, job title, department) are shown, and a person can only look at their own position.
 */
export function MyOrgChartPage() {
  const [chart, setChart] = useState<MyOrgChart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getMyOrgChart()
      .then((c) => live && setChart(c))
      .catch((e) => live && setError(e instanceof ApiError && e.status === 404 ? "Your login is not linked to an employee record yet, so there is no org chart to show." : "The org chart could not be loaded. Try again in a moment."));
    return () => {
      live = false;
    };
  }, []);

  const total = chart ? countAll(chart.downline) : 0;

  return (
    <div data-testid="my-org-chart">
      <BackLink to="/app/ess">Back to Employee Self Service</BackLink>
      <PageHeader title="My Org Chart" subtitle="Your manager, your colleagues and your team." />
      {error && <p className="text-sm text-label-secondary">{error}</p>}
      {!error && !chart && <p className="text-sm text-label-secondary">Loading…</p>}
      {chart && (
        <div className="space-y-6">
          <section aria-label="Departments">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">{chart.departments.length > 1 ? "Departments I work with" : "My department"}</h2>
            {chart.departments.length === 0 ? (
              <p className="text-sm text-label-secondary">No department is recorded on your profile.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" data-testid="org-departments">
                {chart.departments.map((d) => (
                  <li key={d} className="rounded-full bg-accent/10 text-accent text-xs font-medium px-3 py-1">
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Reporting line">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">Reporting line</h2>
            <ol className="space-y-2 max-w-md" data-testid="org-chain">
              {chart.managerChain.map((m, i) => (
                <li key={m.id} style={{ marginLeft: `${i * 12}px` }}>
                  <PersonCard person={m} testId="org-manager" />
                </li>
              ))}
              <li style={{ marginLeft: `${chart.managerChain.length * 12}px` }}>
                <PersonCard person={chart.me} highlight testId="org-me" />
              </li>
            </ol>
            {chart.managerChain.length === 0 && <p className="text-xs text-label-tertiary mt-2">You are at the top of your reporting line.</p>}
          </section>

          <section aria-label="Colleagues">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">My colleagues ({chart.peers.length})</h2>
            {chart.peers.length === 0 ? (
              <p className="text-sm text-label-secondary">No one else reports to the same manager.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="org-peers">
                {chart.peers.map((p) => (
                  <PersonCard key={p.id} person={p} testId="org-peer" />
                ))}
              </div>
            )}
          </section>

          <section aria-label="My team">
            <h2 className="text-sm font-semibold text-label-secondary mb-2">
              My team ({chart.downline.length} direct{total > chart.downline.length ? `, ${total} in total` : ""})
            </h2>
            {chart.downline.length === 0 ? (
              <p className="text-sm text-label-secondary">No one reports to you.</p>
            ) : (
              <ul className="space-y-2" data-testid="org-team">
                {chart.downline.map((n) => (
                  <TeamNode key={n.id} node={n} depth={0} />
                ))}
              </ul>
            )}
            {chart.truncated && <p className="text-xs text-label-tertiary mt-2">Your team is very large, so only the first part is shown.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
