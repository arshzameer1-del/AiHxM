import { useEffect, useState } from "react";
import type { ReviewCycleView } from "@boostfactor/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { CreateCycleModal } from "./modals/CreateCycleModal";

export function ReviewCyclesPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];

  const [cycles, setCycles] = useState<ReviewCycleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const canCreateCycle = roleKeys.includes("hr_admin");

  const loadCycles = async () => {
    try {
      setLoading(true);
      const data = await api.listReviewCycles();
      setCycles(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load review cycles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCycles();
  }, []);

  const handleLaunch = async (id: string) => {
    try {
      const updated = await api.launchReviewCycle(id);
      setCycles((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch cycle");
    }
  };

  const handleBeginCalibration = async (id: string) => {
    try {
      const updated = await api.beginCalibration(id);
      setCycles((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to begin calibration");
    }
  };

  const handleClose = async (id: string) => {
    try {
      const result = await api.closeReviewCycle(id);
      setCycles((prev) => prev.map((c) => (c.id === id ? result.cycle : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close cycle");
    }
  };

  const getStatusBadge = (status: ReviewCycleView["status"]) => {
    const statusColors = {
      draft: "bg-gray-100 text-gray-700",
      active: "bg-blue-100 text-blue-700",
      calibration: "bg-yellow-100 text-yellow-700",
      closed: "bg-green-100 text-green-700",
    };
    return (
      <span
        className={`inline-block px-2 py-1 text-xs font-semibold rounded ${statusColors[status]}`}
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  if (loading) {
    return <div className="text-gray-500">Loading review cycles...</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      {canCreateCycle && (
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium"
        >
          New Review Cycle
        </button>
      )}

      {showCreateModal && <CreateCycleModal onClose={() => setShowCreateModal(false)} onSuccess={loadCycles} />}

      {cycles.length === 0 ? (
        <div className="text-gray-500 text-sm">No review cycles yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 px-4 font-semibold">Name</th>
                <th className="text-left py-2 px-4 font-semibold">Period</th>
                <th className="text-left py-2 px-4 font-semibold">Status</th>
                <th className="text-left py-2 px-4 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((cycle) => (
                <tr key={cycle.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-4">{cycle.name}</td>
                  <td className="py-3 px-4">
                    {new Date(cycle.periodStart).toLocaleDateString()} — {new Date(cycle.periodEnd).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4">{getStatusBadge(cycle.status)}</td>
                  <td className="py-3 px-4">
                    <div className="flex gap-2">
                      {canCreateCycle && cycle.status === "draft" && (
                        <button
                          onClick={() => handleLaunch(cycle.id)}
                          className="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600"
                        >
                          Launch
                        </button>
                      )}
                      {canCreateCycle && cycle.status === "active" && (
                        <button
                          onClick={() => handleBeginCalibration(cycle.id)}
                          className="px-2 py-1 bg-yellow-500 text-white text-xs rounded hover:bg-yellow-600"
                        >
                          Begin Calibration
                        </button>
                      )}
                      {canCreateCycle && cycle.status === "calibration" && (
                        <button
                          onClick={() => handleClose(cycle.id)}
                          className="px-2 py-1 bg-green-500 text-white text-xs rounded hover:bg-green-600"
                        >
                          Close
                        </button>
                      )}
                      {cycle.status === "closed" && (
                        <span className="text-gray-500 text-xs">Completed</span>
                      )}
                    </div>
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
