import { useAuth } from "../../auth/AuthContext";
import { TileGrid, TileGroup } from "../shared/Tiles";
import { buildEssTileGroups } from "./essTiles";
import { ProfileCompletenessCard } from "../employees/ProfileCompletenessCard";

/** The Employee Self Service launchpad: one tile per self-service task. Tiles with no feature behind them yet say so. */
export function EssTiles() {
  const { identity } = useAuth();
  const groups = buildEssTileGroups(identity?.enabledModules ?? []);
  return (
    <div data-testid="ess-launchpad">
      {groups.map((g) => (
        <TileGroup key={g.key} title={g.title}>
          <TileGrid label={g.title} tiles={g.tiles} />
        </TileGroup>
      ))}
    </div>
  );
}

export function EssLaunchpadPage() {
  const { identity } = useAuth();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Employee Self Service</h1>
      <p className="text-sm text-label-tertiary mt-1 mb-6">Your own data and requests in one place. Greyed tiles are not available yet.</p>
      {identity?.employeeId && <ProfileCompletenessCard compact />}
      <EssTiles />
    </div>
  );
}
