import type { LucideIcon } from "lucide-react";

/**
 * A small number tile: icon square, a big value and its label (the One exD "Directory" tiles). Plain white card in the other
 * themes, a soft pink-corner card with a wine icon square in One exD. Pass `onClick` to make it a filter button.
 */
export function StatTile({
  icon: Icon,
  value,
  label,
  onClick,
  active = false,
  testId,
}: {
  icon: LucideIcon;
  value: string | number;
  label: string;
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <span className="stat-tile-icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 text-left">
        <span className="stat-tile-value block text-2xl font-bold leading-tight tabular-nums">{value}</span>
        <span className="stat-tile-label block text-xs text-label-secondary truncate">{label}</span>
      </span>
    </>
  );
  const className = `stat-tile ${active ? "is-active " : ""}bg-card rounded-card shadow-sm p-4 flex items-center gap-3 w-full`;
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className={className} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={className} data-testid={testId}>
      {body}
    </div>
  );
}
