import type { ReactNode } from "react";

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

/** The One exD profile header: avatar, name, number chip, job line and fact chips; `actions` sit at the top right. */
export function ProfileHero({
  name,
  badge,
  title,
  line,
  facts,
  actions,
}: {
  name: string;
  badge?: string;
  title?: string | null;
  line?: string | null;
  facts: { label: string; value: string; dot?: "on" | "off" }[];
  actions?: ReactNode;
}) {
  return (
    <section className="ws-hero" aria-label="Profile">
      <div className="ws-hero-avatar" aria-hidden="true">
        {initialsOf(name)}
      </div>
      <div className="ws-hero-body">
        <div className="ws-hero-name">
          <h1>{name}</h1>
          {badge && <span className="ws-hero-empno">{badge}</span>}
        </div>
        {title && <div className="ws-hero-title">{title}</div>}
        {line && <div className="ws-hero-job">{line}</div>}
        <dl className="ws-hero-facts">
          {facts.map((f) => (
            <div key={f.label} className="ws-hero-fact">
              <dt>{f.label}</dt>
              <dd>
                {f.dot && <span className={`ws-dot ws-dot-${f.dot}`} aria-hidden="true" />}
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {actions && <div className="ws-hero-actions">{actions}</div>}
    </section>
  );
}
