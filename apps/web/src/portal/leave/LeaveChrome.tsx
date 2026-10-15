import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, UserRoundX } from "lucide-react";

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


/** Yellow banner shown on every page while HR works on behalf of another employee; the icon ends it. */
export function OnBehalfBanner({ name, number, stopTo }: { name: string; number: string; stopTo: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-amber-50 border border-amber-300 px-3 py-2 mb-4 text-sm text-amber-900" data-testid="on-behalf-banner">
      <span>
        You are acting on behalf of employee “{name} ({number})”
      </span>
      <Link to={stopTo} aria-label="Stop acting on behalf" title="Stop acting on behalf" className="inline-flex p-1 text-amber-900 hover:text-danger">
        <UserRoundX size={18} strokeWidth={1.75} />
      </Link>
    </div>
  );
}
