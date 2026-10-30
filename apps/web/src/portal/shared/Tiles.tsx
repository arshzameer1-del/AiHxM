import { useT } from "../../i18n/i18n";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { hueOf } from "../../components/shell/hue";

/**
 * Launchpad tiles: each tile is one task and opens its own page. Same size, same layout, and the
 * grid uses the whole page width (1 column on a phone, up to 4 on a wide screen).
 */
export type TileSpec = {
  /** Where the tile goes. A tile without a target (or with `comingSoon`) is shown but cannot be opened. */
  to?: string;
  /** Feature not available yet: the tile is shown greyed out with a "Coming soon" label. */
  comingSoon?: boolean;
  /** Small line under the description, e.g. "Confidential". */
  note?: string;
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

function TileBody({ spec }: { spec: TileSpec }) {
  const t = useT();
  const Icon = spec.icon;
  const dim = spec.comingSoon || !spec.to;
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className={`hue-chip tile-ic inline-flex p-2 rounded-md ${dim ? "bg-black/5 text-label-tertiary is-dim" : "bg-accent/10 text-accent"}`} data-hue={hueOf(spec.title)}>
          <Icon size={22} strokeWidth={1.75} aria-hidden />
        </span>
        {spec.comingSoon ? (
          <span className="rounded-full bg-black/5 text-label-secondary text-[11px] font-semibold px-2 py-0.5">Coming soon</span>
        ) : spec.badge ? (
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
        <h2 className={`text-sm font-bold ${dim ? "text-label-secondary" : "group-hover:text-accent"}`}>{t(spec.title)}</h2>
        <p className="text-xs text-label-secondary mt-0.5">{t(spec.description)}</p>
        {spec.note && <p className="text-xs text-label-tertiary mt-1">{spec.note}</p>}
      </div>
    </>
  );
}

export function Tile({ spec }: { spec: TileSpec }) {
  const box = "launch-tile group relative flex flex-col justify-between min-h-[168px] rounded-md p-4 ui-card";
  if (spec.comingSoon || !spec.to) {
    return (
      <div role="group" aria-disabled="true" aria-label={`${spec.title} (coming soon)`} data-testid={spec.testId} className={`${box} bg-black/[0.03]`}>
        <TileBody spec={spec} />
      </div>
    );
  }
  return (
    <Link
      to={spec.to}
      data-testid={spec.testId}
      aria-label={spec.title}
      className={`${box} bg-white shadow-sm`}
    >
      <TileBody spec={spec} />
    </Link>
  );
}

export function TileGrid({ tiles, label }: { tiles: TileSpec[]; label: string }) {
  return (
    <div role="navigation" aria-label={label} className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {tiles.map((t) => (
        <Tile key={t.testId ?? `${t.to ?? ""}|${t.title}`} spec={t} />
      ))}
    </div>
  );
}

export function TileGroup({ title, children }: { title: string; children: ReactNode }) {
  const t = useT();
  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold uppercase tracking-wide text-label-tertiary mb-2">{t(title)}</h2>
      {children}
    </section>
  );
}
