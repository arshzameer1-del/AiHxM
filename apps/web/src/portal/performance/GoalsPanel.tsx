import { useEffect, useState } from "react";
import type { GoalView } from "@boostfactor/shared-types";
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
    return <div className="text-gray-500">Loading goals...</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      {goals.length === 0 ? (
        <div className="text-gray-500 text-sm">No goals yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 px-4 font-semibold">Title</th>
                <th className="text-left py-2 px-4 font-semibold">Description</th>
                <th className="text-left py-2 px-4 font-semibold">Weight</th>
                <th className="text-left py-2 px-4 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((goal) => (
                <tr key={goal.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-4 font-medium">{goal.title}</td>
                  <td className="py-3 px-4 text-gray-600">{goal.description || "-"}</td>
                  <td className="py-3 px-4">{goal.weight ?? "-"}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
                      goal.status === "active" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700"
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
