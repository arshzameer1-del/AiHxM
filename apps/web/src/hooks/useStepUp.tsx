import { useCallback, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { StepUpModal } from "../components/StepUpModal";

type PendingResolution = {
  resolve: () => void;
  reject: (err: unknown) => void;
};

/**
 * Phase 2 gap-fill item #2 — step-up re-authentication. Wraps any API call
 * that might hit a `@RequireStepUp()` route: on a normal response it's a
 * transparent passthrough; on StepUpGuard's 403 (`ApiError.code ===
 * "step_up_required"`) it shows StepUpModal, verifies the code the user
 * enters via `POST /auth/step-up`, and — only on success — retries the
 * original action exactly once. A cancelled or failed verification rejects
 * with the original error instead of silently swallowing the action.
 *
 * Usage:
 *   const { runWithStepUp, stepUpModal } = useStepUp();
 *   await runWithStepUp(() => api.createPlatformAdmin(input));
 *   // ...and render {stepUpModal} once, near the top of the component tree.
 */
export function useStepUp() {
  const [visible, setVisible] = useState(false);
  const pendingRef = useRef<PendingResolution | null>(null);

  const runWithStepUp = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "step_up_required") {
        throw err;
      }
      await new Promise<void>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        setVisible(true);
      });
      // The user verified successfully — retry the original action exactly
      // once. If IT also somehow comes back step-up-required (a very tight
      // TTL edge case), that surfaces as a normal ApiError to the caller
      // rather than looping the modal indefinitely.
      return await action();
    }
  }, []);

  const handleVerify = useCallback(async (credential: { totpCode?: string; recoveryCode?: string }) => {
    await api.verifyStepUp(credential);
    setVisible(false);
    pendingRef.current?.resolve();
    pendingRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
    pendingRef.current?.reject(new Error("Step-up verification was cancelled."));
    pendingRef.current = null;
  }, []);

  const stepUpModal = visible ? <StepUpModal onVerify={handleVerify} onCancel={handleCancel} /> : null;

  return { runWithStepUp, stepUpModal };
}
