import { useCallback, useEffect, useState } from "react";

const COLLAPSED_KEY = "aihxm.sidebarCollapsed";
const NARROW_QUERY = "(max-width: 767px)";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // storage blocked: the choice just lasts for this visit
  }
}

function readNarrow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * The side menu works like the one in the Claude app. On a computer it is always there: wide (icon and name) or collapsed to a slim
 * icon strip, switched with one button and remembered for the next visit. On a phone it is hidden and slides over the page from the
 * menu button, closing after a choice, on Escape, or on a tap outside.
 */
export function useSidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(NARROW_QUERY);
    } catch {
      return;
    }
    const onChange = () => {
      setNarrow(query.matches);
      setDrawerOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setCollapsedPersisted = useCallback((value: boolean) => {
    setCollapsed(value);
    writeCollapsed(value);
  }, []);

  /** The menu button: collapse or widen the menu on a computer, open or close the drawer on a phone. */
  const toggle = useCallback(() => {
    if (narrow) setDrawerOpen((o) => !o);
    else setCollapsedPersisted(!collapsed);
  }, [narrow, collapsed, setCollapsedPersisted]);

  const expand = useCallback(() => setCollapsedPersisted(false), [setCollapsedPersisted]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const drawer = narrow && drawerOpen;
  return {
    narrow,
    /** Icon strip only. Never true on a phone: the drawer always shows names. */
    collapsed: !narrow && collapsed,
    /** The menu is on screen: always on a computer, only while the drawer is open on a phone. */
    visible: !narrow || drawer,
    drawer,
    toggle,
    expand,
    closeDrawer,
  };
}
