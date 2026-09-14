/**
 * A truthful placeholder, not a finished screen dressed up as one — per
 * the "never claim to have inspected/built something that isn't actually
 * there" discipline this project runs under. The route exists so the nav
 * built in Task #47 is real and clickable end-to-end; the actual screen
 * for each of these areas is built in Tasks #48-52, against the
 * already-tested API these routes will eventually call.
 */
export function ComingSoonPage({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">{title}</h1>
      <div className="bg-card rounded-card p-6 shadow-sm mt-6">
        <p className="text-sm text-label-secondary">{description}</p>
        <p className="text-xs text-label-tertiary mt-3">
          This screen isn't built yet — the API behind it is already real and tested, this portal just
          doesn't have a UI for it yet.
        </p>
      </div>
    </div>
  );
}
