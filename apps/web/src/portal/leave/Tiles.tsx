import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

/**
 * Launchpad tiles: each tile is one task and opens its own page. Same size, same layout, and the
 * grid uses the whole page width (1 column on a phone, up to 4 on a wide screen).
 */
export type TileSpec = {
  to: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Optional headline figure shown large (e.g. "12.5") with `figureLabel` under it. */
  figure?: string | number | null;
  figureLabel?: string;
  /** Small pill in the corner, e.g. a count of items waiting. Hidden when 0/undefined. */
  badge?: number;
  testId?: string;
};

export function Tile({ spec }: { spec: TileSpec }) {
  const Icon = spec.icon;
  return (
    <Link
      to={spec.to}
      data-testid={spec.testId}
      aria-label={spec.title}
      className="group relative flex flex-col justify-between min-h-[168px] bg-white rounded-md border border-black/10 shadow-sm p-4 hover:border-accent hover:shadow transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex p-2 rounded-md bg-accent/10 text-accent">
          <Icon size={22} strokeWidth={1.75} aria-hidden />
        </span>
        {spec.badge ? (
          <span className="rounded-full bg-danger text-white text-xs font-semibold px-2 py-0.5 tabular-nums" aria-label={`${spec.badge} waiting`}>
            {spec.badge}
          </span>
        ) : null}
      </div>
      <div className="mt-4">
        {spec.figure !== undefined && spec.figure !== null && (
          <div className="mb-1">
            <span className="text-3xl font-bold tabular-nums">{spec.figure}</span>
            {spec.figureLabel && <span className="ml-1.5 text-xs text-label-tertiary">{spec.figureLabel}</span>}
          </div>
        )}
        <h2 className="text-sm font-bold group-hover:text-accent">{spec.title}</h2>
        <p className="text-xs text-label-secondary mt-0.5">{spec.description}</p>
      </div>
    </Link>
  );
}

export function TileGrid({ tiles, label }: { tiles: TileSpec[]; label: string }) {
  return (
    <div role="navigation" aria-label={label} className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {tiles.map((t) => (
        <Tile key={t.to} spec={t} />
      ))}
    </div>
  );
}

export function TileGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold uppercase tracking-wide text-label-tertiary mb-2">{title}</h2>
      {children}
    </section>
  );
}
