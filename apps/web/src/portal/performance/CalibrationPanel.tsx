import { useEffect, useState } from "react";
import type { PerformanceReviewView, ReviewCycleView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

export function CalibrationPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];

  const [cycles, setCycles] = useState<ReviewCycleView[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<PerformanceReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canCalibrate = roleKeys.includes("hr_admin");

  useEffect(() => {
    const loadCycles = async () => {
      try {
        setLoading(true);
        const data = await api.listReviewCycles();
        const calibrationCycles = data.filter((c) => c.status === "calibration");
        setCycles(calibrationCycles);
        if (calibrationCycles.length > 0) {
          setSelectedCycleId(calibrationCycles[0].id);
        }
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load cycles");
      } finally {
        setLoading(false);
      }
    };

    loadCycles();
  }, []);

  useEffect(() => {
    const loadReviews = async () => {
      if (!selectedCycleId) return;
      try {
        const data = await api.listPerformanceReviews({ reviewCycleId: selectedCycleId });
        const pendingReviews = data.filter(
          (r) => r.status === "pending" || r.status === "in_progress" || r.status === "completed"
        );
        setReviews(pendingReviews);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load reviews");
      }
    };

    loadReviews();
  }, [selectedCycleId]);

  const handleCalibrateReview = async (reviewId: string, rating: number, comment: string) => {
    try {
      const updated = await api.calibrateReview(reviewId, { calibrationRating: rating, calibrationComment: comment });
      setReviews((prev) => prev.map((r) => (r.id === reviewId ? updated : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to calibrate review");
    }
  };

  if (!canCalibrate) {
    return <div className="text-label-secondary">Calibration is available to HR administrators only.</div>;
  }

  if (loading) {
    return <div className="text-label-tertiary">Loading calibration data...</div>;
  }

  if (cycles.length === 0) {
    return <div className="text-label-secondary">No cycles in calibration phase</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      <div>
        <label className="block text-sm font-medium text-label-primary mb-2">Select Cycle</label>
        <select
          value={selectedCycleId || ""}
          onChange={(e) => setSelectedCycleId(e.target.value)}
          className="w-full px-3 py-2 border border-black/20 rounded hover:border-black/20 focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {cycles.map((cycle) => (
            <option key={cycle.id} value={cycle.id}>
              {cycle.name}
            </option>
          ))}
        </select>
      </div>

      {reviews.length === 0 ? (
        <div className="text-label-tertiary text-sm">No pending reviews to calibrate</div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-label-secondary">
            {reviews.length} review{reviews.length !== 1 ? "s" : ""} pending calibration
          </p>
          <div className="space-y-3">
            {reviews.map((review) => (
              <CalibrationReviewCard
                key={review.id}
                review={review}
                onCalibrateClick={handleCalibrateReview}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CalibrationReviewCard({
  review,
  onCalibrateClick,
}: {
  review: PerformanceReviewView;
  onCalibrateClick: (id: string, rating: number, comment: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [rating, setRating] = useState(review.calibrationRating ?? review.managerRating ?? 3);
  const [comment, setComment] = useState(review.calibrationComment ?? "");

  const handleSubmit = async () => {
    await onCalibrateClick(review.id, rating, comment);
    setIsEditing(false);
  };

  return (
    <div className="border border-black/10 rounded-lg p-4 bg-white">
      <div className="flex justify-between items-start mb-3">
        <div>
          <p className="font-medium">{review.employeeId}</p>
          <p className="text-xs text-label-secondary">{review.status}</p>
        </div>
        <div className="text-sm">
          {review.managerRating && (
            <p className="text-label-secondary">Manager rated: <span className="font-semibold">{review.managerRating}/5</span></p>
          )}
        </div>
      </div>

      {review.managerAssessment && (
        <div className="mb-3 p-3 bg-surface rounded text-sm">
          <p className="text-label-primary">{review.managerAssessment}</p>
        </div>
      )}

      {!isEditing && review.calibratedAt ? (
        <div className="text-sm text-green-700 bg-green-50 p-2 rounded">Calibrated</div>
      ) : (
        <>
          {isEditing ? (
            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium text-label-primary mb-1">Calibrated Rating</label>
                <select
                  value={rating}
                  onChange={(e) => setRating(Number(e.target.value))}
                  className="w-full px-2 py-1 border border-black/20 rounded text-sm"
                >
                  {[1, 2, 3, 4, 5].map((r) => (
                    <option key={r} value={r}>
                      {r} / 5
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-label-primary mb-1">Comment</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="w-full px-2 py-1 border border-black/20 rounded text-sm"
                  rows={2}
                  placeholder="Calibration notes..."
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSubmit}
                  className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                >
                  Save
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1 bg-black/10 text-label-primary text-xs rounded hover:bg-black/20"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="text-accent hover:underline text-xs font-medium"
            >
              Calibrate
            </button>
          )}
        </>
      )}
    </div>
  );
}
