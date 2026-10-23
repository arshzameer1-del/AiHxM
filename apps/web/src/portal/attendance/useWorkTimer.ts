import { useCallback, useEffect, useState } from "react";
import { clearTimer, elapsedSeconds, readTimer, startTimer, TIMER_EVENT, TIMER_KEY, type WorkTimer } from "./workTimer";

/** The running work timer for one person, kept in step across the page and the top bar, ticking once a second while it runs. */
export function useWorkTimer(employeeId: string | undefined): {
  timer: WorkTimer | null;
  seconds: number;
  start: (label: string) => void;
  discard: () => void;
} {
  const [timer, setTimer] = useState<WorkTimer | null>(() => (employeeId ? readTimer(employeeId) : null));
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const sync = () => setTimer(employeeId ? readTimer(employeeId) : null);
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === TIMER_KEY || e.key === null) sync();
    };
    window.addEventListener(TIMER_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TIMER_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [employeeId]);

  useEffect(() => {
    if (!timer) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [timer]);

  const start = useCallback((label: string) => {
    if (employeeId) startTimer(employeeId, label);
  }, [employeeId]);
  const discard = useCallback(() => clearTimer(), []);
  return { timer, seconds: timer ? elapsedSeconds(timer, now) : 0, start, discard };
}
