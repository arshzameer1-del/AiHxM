import { useEffect, useState } from "react";
import { api } from "../../api/client";

/**
 * BACKLOG55 - one place that fetches an employee's profile photo and shares it between the avatar in the top bar, the
 * home banner, My Profile and the HR employee page, so a change shows everywhere at once.
 */
const urls = new Map<string, Promise<string | null>>();
const EVENT = "aihxm:photo-changed";

/** At most this many photo downloads run at once; the rest wait their turn (a long list must not flood the API). */
const MAX_PARALLEL = 6;
let running = 0;
const waiting: Array<() => void> = [];
function slot<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      job().then(resolve, reject).finally(() => {
        running -= 1;
        waiting.shift()?.();
      });
    };
    if (running < MAX_PARALLEL) start();
    else waiting.push(start);
  });
}

export function loadEmployeePhoto(employeeId: string): Promise<string | null> {
  let p = urls.get(employeeId);
  if (!p) {
    p = slot(() => api.getEmployeePhotoUrl(employeeId)).catch(() => null);
    urls.set(employeeId, p);
  }
  return p;
}

/** Call after a photo was uploaded or approved: every avatar for this person reloads. */
export function photoChanged(employeeId: string): void {
  urls.delete(employeeId);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: employeeId }));
}

export function useEmployeePhoto(employeeId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!employeeId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    const load = () => loadEmployeePhoto(employeeId).then((u) => !cancelled && setUrl(u));
    load();
    const onChange = (e: Event) => {
      if ((e as CustomEvent).detail === employeeId) load();
    };
    window.addEventListener(EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, onChange);
    };
  }, [employeeId]);
  return url;
}
