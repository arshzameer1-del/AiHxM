import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="text-label-tertiary text-sm mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline mb-3">
      <ArrowLeft size={15} /> {children}
    </Link>
  );
}

/** "Loading …" that says so when the answer is slow, instead of sitting silent (LIVE-05). */
export function LoadingNote({ what }: { what?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <p className="text-sm text-label-tertiary" role="status" data-testid="loading-note">
      Loading{what ? ` ${what}` : ""}…{slow ? " This is taking longer than usual; it will appear as soon as the server answers." : ""}
    </p>
  );
}
