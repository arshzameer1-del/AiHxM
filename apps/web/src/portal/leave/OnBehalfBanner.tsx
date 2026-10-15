import { Link } from "react-router-dom";
import { UserRoundX } from "lucide-react";

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
