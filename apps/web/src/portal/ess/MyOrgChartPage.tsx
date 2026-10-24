import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { MyOrgChart, MyOrgChartNode, MyOrgChartPerson } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { BackLink, PageHeader } from "../shared/PageChrome";
import { EmployeeAvatar } from "../shared/EmployeeAvatar";

function countAll(nodes: MyOrgChartNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countAll(x.directReports), 0);
}

/** One box of the chart: the person plus the people drawn below them. */
type ChartNode = { person: MyOrgChartPerson; kind: "manager" | "me" | "peer" | "report"; children: ChartNode[]; teamSize: number; level: number };

function fromDownline(n: MyOrgChartNode, level: number): ChartNode {
  return { person: n, kind: "report", level, children: n.directReports.map((c) => fromDownline(c, level + 1)), teamSize: countAll(n.directReports) };
}

/**
 * Builds the tree the chart draws: the manager chain runs down the middle (top person first), the signed-in person sits
 * in one row with the colleagues who share their manager (in the middle of that row), and their own team hangs below.
 */
function buildTree(chart: MyOrgChart): ChartNode[] {
  const me: ChartNode = { person: chart.me, kind: "me", children: chart.downline.map((n) => fromDownline(n, 0)), teamSize: countAll(chart.downline), level: 0 };
  const peers: ChartNode[] = chart.peers.map((p) => ({ person: p, kind: "peer", children: [], teamSize: 0, level: 0 }));
  const mid = Math.floor(peers.length / 2);
  let level: ChartNode[] = [...peers.slice(0, mid), me, ...peers.slice(mid)];
  for (let i = chart.managerChain.length - 1; i >= 0; i--) {
    level = [{ person: chart.managerChain[i], kind: "manager", children: level, teamSize: 0, level: 0 }];
  }
  return level;
}

const TEST_ID: Record<ChartNode["kind"], string> = { manager: "org-manager", me: "org-me", peer: "org-peer", report: "org-report" };

function OrgBox({ node, open, onToggle }: { node: ChartNode; open: boolean; onToggle?: () => void }) {
  const isMe = node.kind === "me";
  return (
    <div className="relative">
      <div data-testid={TEST_ID[node.kind]} className={`orgnode rounded-lg p-3 text-center ${isMe ? "orgnode-me" : ""}`}>
        <EmployeeAvatar employeeId={node.person.id} name={node.person.fullName} size="md" tone={isMe ? "solid" : "soft"} className="mx-auto" />
        <p className="mt-2 text-sm font-semibold leading-tight break-words">
          {node.person.fullName}
          {isMe && <span className="ml-1.5 text-xs font-medium text-accent">(You)</span>}
        </p>
        <p className="text-xs text-label-secondary leading-tight mt-0.5 break-words">{node.person.designation ?? "—"}</p>
        {node.person.department && <p className="text-xs text-label-tertiary leading-tight mt-0.5 break-words">{node.person.department}</p>}
      </div>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${node.person.fullName}'s team`}
          className="relative z-10 mt-1.5 mx-auto flex items-center gap-0.5 rounded-full bg-card px-2 py-0.5 text-xs font-medium text-accent shadow-sm ring-1 ring-accent/40 hover:ring-accent"
        >
          {node.teamSize}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
    </div>
  );
}

function ChartBranch({ node }: { node: ChartNode }) {
  // Keep the first two levels of a team open so the chart is useful at a glance; deeper teams open on demand.
  const [open, setOpen] = useState(node.kind !== "report" || node.level < 2);
  const has = node.children.length > 0;
  return (
    <li>
      <OrgBox node={node} open={open} onToggle={has && node.kind === "report" ? () => setOpen((v) => !v) : undefined} />
      {has && open && (
        <ul>
          {node.children.map((c) => (
            <ChartBranch key={c.person.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * "My Org Chart" (Employee Self Service): where the signed-in person sits, drawn as a top-down chart. Their manager chain
 * on top, they and their colleagues under the same manager in one row, and everyone below them — across departments, so a
 * manager sees all of their own teams. Only public fields (name, job title, department) are shown, and a person can only
 * look at their own position.
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

  const tree = useMemo(() => (chart ? buildTree(chart) : []), [chart]);
  const treeRef = useRef<HTMLDivElement>(null);

  // A wide chart scrolls sideways: start with the signed-in person in the middle of the view, not at the far left.
  useEffect(() => {
    const box = treeRef.current;
    const me = box?.querySelector<HTMLElement>('[data-testid="org-me"]');
    if (!box || !me) return;
    const b = box.getBoundingClientRect();
    const m = me.getBoundingClientRect();
    box.scrollLeft += m.left - b.left - (b.width - m.width) / 2;
  }, [tree]);
  const total = chart ? countAll(chart.downline) : 0;

  return (
    <div data-testid="my-org-chart">
      <BackLink to="/app/ess">Back to Employee Self Service</BackLink>
      <PageHeader title="My Org Chart" subtitle="Your manager, your colleagues and your team." />
      {error && <p className="text-sm text-label-secondary">{error}</p>}
      {!error && !chart && <p className="text-sm text-label-secondary">Loading…</p>}
      {chart && (
        <div className="space-y-4">
          <section aria-label="Departments" className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-label-secondary mr-1">{chart.departments.length > 1 ? "Departments I work with" : "My department"}</h2>
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

          <p className="text-xs text-label-tertiary" data-testid="org-summary">
            {chart.managerChain.length === 0 ? "You are at the top of your reporting line. " : ""}
            {chart.peers.length} colleague{chart.peers.length === 1 ? "" : "s"} under the same manager · {chart.downline.length} direct report{chart.downline.length === 1 ? "" : "s"}
            {total > chart.downline.length ? ` (${total} in total)` : ""}
          </p>

          <div className="orgtree" ref={treeRef} data-testid="org-chart-tree" role="group" aria-label="Organization chart">
            <ul>
              {tree.map((n) => (
                <ChartBranch key={n.person.id} node={n} />
              ))}
            </ul>
          </div>
          {chart.truncated && <p className="text-xs text-label-tertiary">Your team is very large, so only the first part is shown.</p>}
        </div>
      )}
    </div>
  );
}
