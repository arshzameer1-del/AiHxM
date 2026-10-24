import { HOME_BANNER_PRESETS, isDarkEnoughForWhiteText, type CompanyAppearanceView, type HomeBannerPresetKey } from "@aihxm/shared-types";

/** The CSS background of the home banner for a saved setting. `imageUrl` is the blob: URL of the uploaded picture. */
export function bannerBackground(a: Pick<CompanyAppearanceView, "bannerMode" | "bannerPreset" | "bannerColor"> | null, imageUrl: string | null): string | undefined {
  if (!a || a.bannerMode === "default") return undefined;
  if (a.bannerMode === "preset") {
    const p = HOME_BANNER_PRESETS.find((x) => x.key === a.bannerPreset);
    return p ? `radial-gradient(70% 140% at 100% 0%, rgb(255 255 255 / 0.12), transparent 62%), linear-gradient(118deg, ${p.from} 0%, ${p.to} 100%)` : undefined;
  }
  if (a.bannerMode === "color" && a.bannerColor && isDarkEnoughForWhiteText(a.bannerColor)) {
    return `radial-gradient(70% 140% at 100% 0%, rgb(255 255 255 / 0.12), transparent 62%), linear-gradient(118deg, ${a.bannerColor} 0%, color-mix(in srgb, ${a.bannerColor} 55%, #000) 100%)`;
  }
  if (a.bannerMode === "image" && imageUrl) {
    // a dark veil keeps the white text readable on any picture
    return `linear-gradient(rgb(10 12 30 / 0.5), rgb(10 12 30 / 0.5)), url("${imageUrl}") center / cover no-repeat`;
  }
  return undefined;
}

export const presetLabel = (key: HomeBannerPresetKey | null): string => HOME_BANNER_PRESETS.find((p) => p.key === key)?.label ?? "";

/** The first problem with a colour the admin typed or picked, in plain words; null when fine. */
export function colourProblem(hex: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "Use a colour like #1e3a8a.";
  if (!isDarkEnoughForWhiteText(hex)) return "That colour is too light for the white text on the banner. Choose a darker one.";
  return null;
}
