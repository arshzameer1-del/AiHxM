import { Link } from "react-router-dom";
import { Lock } from "lucide-react";

/** Set as a page's error text when the server refuses the read (403); `PageLoadError` then shows the shared panel. */
export const NO_ACCESS = "__no_access__";

/** The one "you do not have access" panel, so every restricted page answers the same way and offers a way back. */
export function NoAccessPanel({ what = "This page" }: { what?: string }) {
  return (
    <div className="max-w-md rounded-lg border border-black/10 bg-white p-5" role="status" data-testid="no-access-panel">
      <div className="flex items-center gap-2 text-sm font-semibold text-label-primary">
        <Lock size={16} aria-hidden="true" /> You do not have access
      </div>
      <p className="mt-2 text-sm text-label-secondary">{what} is only available to people with the right permission. Ask your HR Admin if you need it.</p>
      <Link to="/app" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
        Back to Home
      </Link>
    </div>
  );
}

/** What a page shows when its main read failed: the shared panel for a refusal, a plain red line for anything else. */
export function PageLoadError({ message, what }: { message: string; what?: string }) {
  if (message === NO_ACCESS) return <NoAccessPanel what={what} />;
  return <div className="text-danger text-sm">{message}</div>;
}
