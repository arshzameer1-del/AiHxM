import { useEffect, useState } from "react";
import { api } from "../../api/client";

/**
 * BACKLOG55 - one place that fetches an employee's profile photo and shares it between the avatar in the top bar, the
 * home banner, My Profile and the HR employee page, so a change shows everywhere at once.
 */
const urls = new Map<string, Promise<string | null>>();
const EVENT = "aihxm:photo-changed";

export function loadEmployeePhoto(employeeId: string): Promise<string | null> {
  let p = urls.get(employeeId);
  if (!p) {
    p = api.getEmployeePhotoUrl(employeeId).catch(() => null);
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
