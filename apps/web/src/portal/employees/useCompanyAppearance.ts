import { useEffect, useState } from "react";
import type { CompanyAppearanceView } from "@aihxm/shared-types";
import { api } from "../../api/client";

const EVENT = "aihxm:appearance-changed";
let cached: Promise<{ view: CompanyAppearanceView; imageUrl: string | null }> | null = null;

function fetchAppearance() {
  if (!cached) {
    cached = (async () => {
      const view = (await api.getCompanyAppearance()) as CompanyAppearanceView;
      const imageUrl = view.bannerMode === "image" && view.hasBannerImage ? await api.getBannerImageUrl() : null;
      return { view, imageUrl };
    })().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Call after the System Admin saved a change: every open banner redraws. */
export function appearanceChanged(): void {
  cached = null;
  window.dispatchEvent(new Event(EVENT));
}

/** The company's banner setting (null until loaded, or when it cannot be read - the standard banner is then drawn). */
export function useCompanyAppearance(): { view: CompanyAppearanceView; imageUrl: string | null } | null {
  const [state, setState] = useState<{ view: CompanyAppearanceView; imageUrl: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetchAppearance().then((s) => !cancelled && setState(s)).catch(() => undefined);
    load();
    window.addEventListener(EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, load);
    };
  }, []);
  return state;
}
