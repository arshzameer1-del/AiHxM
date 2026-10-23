import { useCallback, useEffect, useState } from "react";

const PINNED_KEY = "aihxm.sidebarPinned";

function readPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

function writePinned(value: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, value ? "1" : "0");
  } catch {
    // storage blocked: the pin just lasts for this visit
  }
}

const NARROW_QUERY = "(max-width: 767px)";

function readNarrow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * The side menu is closed until someone opens it. Open and unpinned it floats over the page and closes again after a choice or a click
 * outside; pinned it is docked beside the page and stays open (and is remembered for the next visit).
 */
export function useSidebar() {
  const [pinned, setPinned] = useState(readPinned);
  const [open, setOpen] = useState(false);
  // On a phone-width screen a docked menu would take too much room, so there it is always a floating menu (no pin).
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(NARROW_QUERY);
    } catch {
      return;
    }
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const docked = pinned && !narrow;

  /** The 3-line button: shows the menu when hidden, hides it (and unpins it) when shown. A pin left over from a wide screen does not count on a phone. */
  const toggle = useCallback(() => {
    if (docked || open) {
      setPinned(false);
      writePinned(false);
      setOpen(false);
    } else {
      setOpen(true);
    }
  }, [docked, open]);

  /** The pin button: pinning docks the menu; unpinning leaves it open as a floating menu. */
  const togglePin = useCallback(() => {
    if (pinned) {
      setPinned(false);
      writePinned(false);
      setOpen(true);
    } else {
      setPinned(true);
      writePinned(true);
      setOpen(false);
    }
  }, [pinned]);

  /** Closes the floating menu; a pinned menu stays. */
  const closeFloating = useCallback(() => setOpen(false), []);

  return { pinned, narrow, docked, floating: !docked && open, visible: docked || open, toggle, togglePin, closeFloating };
}
