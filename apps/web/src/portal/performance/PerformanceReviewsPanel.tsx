import { useEffect, useState } from "react";
import type { PerformanceReviewView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

export function PerformanceReviewsPanel() {
  const { identity } = useAuth();
  const roleKeys = identity?.roleKeys ?? [];

  const [reviews, setReviews] = useState<PerformanceReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReview, setSelectedReview] = useState<PerformanceReviewView | null>(null);

  useEffect(() => {
    const loadReviews = async () => {
      try {
        setLoading(true);
        const data = await api.listPerformanceReviews();
        setReviews(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load reviews");
      } finally {
        setLoading(false);
      }
    };

    loadReviews();
  }, []);

  const handleSubmitSelfAssessment = async (reviewId: string, assessment: string) => {
    try {
      const updated = await api.submitSelfAssessment(reviewId, { selfAssessment: assessment });
      setReviews((prev) => prev.map((r) => (r.id === reviewId ? updated : r)));
      if (selectedReview) setSelectedReview(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit self assessment");
    }
  };

  const handleSubmitManagerAssessment = async (
    reviewId: string,
    assessment: string,
    rating: number
  ) => {
    try {
      const updated = await api.submitManagerAssessment(reviewId, {
        managerAssessment: assessment,
        managerRating: rating,
      });
      setReviews((prev) => prev.map((r) => (r.id === reviewId ? updated : r)));
      if (selectedReview) setSelectedReview(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit manager assessment");
    }
  };

  const getStatusBadge = (status: PerformanceReviewView["status"]) => {
    const statusColors = {
      pending: "bg-black/5 text-label-primary",
      in_progress: "bg-accent/10 text-accent-dark",
      completed: "bg-green-100 text-green-700",
      calibrated: "bg-yellow-100 text-yellow-700",
      released: "bg-green-200 text-green-800",
    };
    return (
      <span className={`inline-block px-2 py-1 text-xs font-semibold rounded ${statusColors[status]}`}>
        {status.replace(/_/g, " ").charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")}
      </span>
    );
  };

  if (loading) {
    return <div className="text-label-tertiary">Loading reviews...</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}

      {reviews.length === 0 ? (
        <div className="text-label-tertiary text-sm">No reviews yet</div>
      ) : (
        <div className="grid gap-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/10">
                  <th className="text-left py-2 px-4 font-semibold">Employee</th>
                  <th className="text-left py-2 px-4 font-semibold">Status</th>
                  <th className="text-left py-2 px-4 font-semibold">Self Submitted</th>
                  <th className="text-left py-2 px-4 font-semibold">Manager Submitted</th>
                  <th className="text-left py-2 px-4 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={review.id} className="border-b border-black/5 hover:bg-surface">
                    <td className="py-3 px-4">{review.employeeId}</td>
                    <td className="py-3 px-4">{getStatusBadge(review.status)}</td>
                    <td className="py-3 px-4">
                      {review.selfAssessmentSubmittedAt ? "✓" : "-"}
                    </td>
                    <td className="py-3 px-4">
                      {review.managerAssessmentSubmittedAt ? "✓" : "-"}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => setSelectedReview(review)}
                        className="text-accent hover:underline text-xs font-medium"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedReview && (
            <div className="border border-black/10 rounded-lg p-6 bg-surface">
              <div className="flex justify-between items-start mb-4">
                <h3 className="font-semibold">Review Details: {selectedReview.employeeId}</h3>
                <button
                  onClick={() => setSelectedReview(null)}
                  className="text-label-tertiary hover:text-label-primary text-xl leading-none"
                >
                  ×
                </button>
              </div>

              <div className="bg-white p-4 rounded border border-black/10 space-y-6">
                {/* Self Assessment */}
                <div>
                  <h4 className="font-medium mb-2">Self Assessment</h4>
                  {selectedReview.selfAssessmentSubmittedAt ? (
                    <p className="text-sm text-label-primary">{selectedReview.selfAssessment}</p>
                  ) : roleKeys.includes("employee_self_service") ||
                    roleKeys.includes("hr_admin") ? (
                    <AssessmentForm
                      placeholder="Your assessment of your own performance..."
                      onSubmit={(text) => handleSubmitSelfAssessment(selectedReview.id, text)}
                      isManager={false}
                    />
                  ) : (
                    <p className="text-sm text-label-tertiary">Not submitted yet</p>
                  )}
                </div>

                {/* Manager Assessment */}
                <div>
                  <h4 className="font-medium mb-2">Manager Assessment</h4>
                  {selectedReview.managerAssessmentSubmittedAt ? (
                    <div className="text-sm text-label-primary">
                      <p>{selectedReview.managerAssessment}</p>
                      {selectedReview.managerRating && (
                        <p className="text-xs text-label-secondary mt-2">Rating: {selectedReview.managerRating}/5</p>
                      )}
                    </div>
                  ) : roleKeys.includes("line_manager") || roleKeys.includes("hr_admin") ? (
                    <AssessmentForm
                      placeholder="Manager's assessment..."
                      onSubmit={(text) => handleSubmitManagerAssessment(selectedReview.id, text, 3)}
                      isManager={true}
                    />
                  ) : (
                    <p className="text-sm text-label-tertiary">Not submitted yet</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AssessmentForm({
  placeholder,
  onSubmit,
  isManager,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
  isManager: boolean;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      await onSubmit(text);
      setText("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium uppercase tracking-wide text-label-tertiary">
        {isManager ? "Manager assessment" : "Self assessment"}
      </span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-black/20 rounded focus:outline-none focus:ring-2 focus:ring-accent text-sm"
        rows={3}
      />
      <button
        onClick={handleSubmit}
        disabled={loading || !text.trim()}
        className="px-3 py-1 bg-accent text-white text-sm rounded hover:bg-accent-dark disabled:opacity-50"
      >
        {loading ? "Submitting..." : "Submit"}
      </button>
    </div>
  );
}
