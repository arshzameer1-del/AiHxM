/**
 * A donut: one or more coloured arcs on a light track, with a big figure and a small caption in the middle.
 * `segments` are shares of the whole (0..1 each, summing to at most 1). Colours are theme variables, so the ring follows the theme.
 */
export type RingSegment = { fraction: number; color: string };

const R = 42;
const C = 2 * Math.PI * R;

export function ProgressRing({
  segments,
  centre,
  caption,
  size = 92,
  label,
}: {
  segments: RingSegment[];
  centre: string;
  caption?: string;
  size?: number;
  /** Read out by screen readers instead of the drawing. */
  label: string;
}) {
  let offset = 0;
  return (
    <div className="progress-ring relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="11" className="progress-ring-track" />
        {segments
          .filter((s) => s.fraction > 0)
          .map((s, i) => {
            const len = Math.max(0, Math.min(1, s.fraction)) * C;
            const dash = `${Math.max(0, len - (segments.length > 1 ? 1.5 : 0))} ${C}`;
            const el = (
              <circle
                key={i}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                strokeWidth="11"
                strokeLinecap="butt"
                stroke={s.color}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                className="progress-ring-arc"
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight">
        <span className="font-bold tabular-nums" style={{ fontSize: size * 0.2 }}>{centre}</span>
        {caption && <span className="uppercase tracking-wide text-label-tertiary" style={{ fontSize: Math.max(8, size * 0.095) }}>{caption}</span>}
      </div>
    </div>
  );
}
