import { useCallback, useState } from "react";

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

/**
 * The side menu is closed until someone opens it. Open and unpinned it floats over the page and closes again after a choice or a click
 * outside; pinned it is docked beside the page and stays open (and is remembered for the next visit).
 */
export function useSidebar() {
  const [pinned, setPinned] = useState(readPinned);
  const [open, setOpen] = useState(false);

  /** The 3-line button: shows the menu when hidden, hides it (and unpins it) when shown. */
  const toggle = useCallback(() => {
    if (pinned || open) {
      setPinned(false);
      writePinned(false);
      setOpen(false);
    } else {
      setOpen(true);
    }
  }, [pinned, open]);

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

  return { pinned, docked: pinned, floating: !pinned && open, visible: pinned || open, toggle, togglePin, closeFloating };
}
