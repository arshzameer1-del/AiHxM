import { useState } from "react";
import type { CreateReviewCycleRequest } from "@aihxm/shared-types";
import { api } from "../../../api/client";

interface CreateCycleModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateCycleModal({ onClose, onSuccess }: CreateCycleModalProps) {
  const [formData, setFormData] = useState<CreateReviewCycleRequest>({
    name: "",
    periodStart: new Date().toISOString().split("T")[0],
    periodEnd: new Date().toISOString().split("T")[0],
  });

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim()) {
      setError("Cycle name is required");
      return;
    }

    if (!formData.periodStart || !formData.periodEnd) {
      setError("Both start and end dates are required");
      return;
    }

    if (new Date(formData.periodStart) > new Date(formData.periodEnd)) {
      setError("Start date must be before end date");
      return;
    }

    try {
      setLoading(true);
      await api.createReviewCycle(formData);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create cycle");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg p-6 w-96">
        <h2 className="text-lg font-semibold mb-4">Create Review Cycle</h2>

        {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded mb-4">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cycle Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 2026 Annual Review"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              value={formData.periodStart}
              onChange={(e) => setFormData((prev) => ({ ...prev, periodStart: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              value={formData.periodEnd}
              onChange={(e) => setFormData((prev) => ({ ...prev, periodEnd: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-2 justify-end pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
