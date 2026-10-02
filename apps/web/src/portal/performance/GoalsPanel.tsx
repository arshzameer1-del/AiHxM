import { useEffect, useState } from "react";
import type { GoalView } from "@aihxm/shared-types";
import { api } from "../../api/client";

export function GoalsPanel() {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadGoals = async () => {
      try {
        setLoading(true);
        const data = await api.listGoals();
        setGoals(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load goals");
      } finally {
        setLoading(false);
      }
    };

    loadGoals();
  }, []);

  if (loading) {
    return <div className="text-label-tertiary">Loading goals...</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      {goals.length === 0 ? (
        <div className="text-label-tertiary text-sm">No goals yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10">
                <th className="text-left py-2 px-4 font-semibold">Title</th>
                <th className="text-left py-2 px-4 font-semibold">Description</th>
                <th className="text-left py-2 px-4 font-semibold">Weight</th>
                <th className="text-left py-2 px-4 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((goal) => (
                <tr key={goal.id} className="border-b border-black/5 hover:bg-surface">
                  <td className="py-3 px-4 font-medium">{goal.title}</td>
                  <td className="py-3 px-4 text-label-secondary">{goal.description || "-"}</td>
                  <td className="py-3 px-4">{goal.weight ?? "-"}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
                      goal.status === "active" ? "bg-accent/10 text-accent-dark" : "bg-black/5 text-label-primary"
                    }`}>
                      {goal.status.charAt(0).toUpperCase() + goal.status.slice(1)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
