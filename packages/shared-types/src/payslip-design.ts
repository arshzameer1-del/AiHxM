/**
 * Payslip print design (Configuration Center > Payslip print design).
 *
 * One design per company decides how a paystub looks when it is printed or saved as a PDF: paper, margins,
 * typography, colours, header and logo, which blocks appear and in what order, how lines are written, and the
 * footer, signatures and watermark. The same module is used by the API (to validate and store a design) and by the
 * web app (to draw the sheet and the live preview), so the two can never disagree about what is allowed.
 */

export const PAYSLIP_PAPER_SIZES = ["A4", "A5", "Letter"] as const;
export type PayslipPaperSize = (typeof PAYSLIP_PAPER_SIZES)[number];

export const PAYSLIP_FONT_FAMILIES = ["sans", "serif", "humanist", "mono"] as const;
export type PayslipFontFamily = (typeof PAYSLIP_FONT_FAMILIES)[number];

export const PAYSLIP_HEADER_STYLES = ["band", "underline", "plain"] as const;
export type PayslipHeaderStyle = (typeof PAYSLIP_HEADER_STYLES)[number];

export const PAYSLIP_LOGO_POSITIONS = ["none", "left", "center", "right"] as const;
export type PayslipLogoPosition = (typeof PAYSLIP_LOGO_POSITIONS)[number];

/** The facts about the employee and the pay period a design can show in the details block. */
export const PAYSLIP_DETAIL_FIELDS = ["employeeName", "employeeNumber", "payrollPeriod", "payDate", "paidDays", "payrollType", "bankAccount"] as const;
export type PayslipDetailField = (typeof PAYSLIP_DETAIL_FIELDS)[number];
export const PAYSLIP_DETAIL_FIELD_LABELS: Record<PayslipDetailField, string> = {
  employeeName: "Employee name",
  employeeNumber: "Employee no.",
  payrollPeriod: "Payroll period",
  payDate: "Pay date",
  paidDays: "Paid days",
  payrollType: "Payroll type",
  bankAccount: "Bank account",
};

/** The blocks of the sheet below the header, in the order the design lists them. */
export const PAYSLIP_SECTION_KEYS = ["details", "earnings", "deductions", "employerContributions", "summary", "amountInWords", "calculation", "notes"] as const;
export type PayslipSectionKey = (typeof PAYSLIP_SECTION_KEYS)[number];
export const PAYSLIP_SECTION_LABELS: Record<PayslipSectionKey, string> = {
  details: "Employee and period details",
  earnings: "Earnings",
  deductions: "Deductions",
  employerContributions: "Employer contributions",
  summary: "Gross, deductions and take-home pay",
  amountInWords: "Take-home pay in words",
  calculation: "Calculation steps",
  notes: "Footer note and signatures",
};

export type PayslipDesignSection = { key: PayslipSectionKey; enabled: boolean };

export type PayslipPrintDesign = {
  page: { size: PayslipPaperSize; orientation: "portrait" | "landscape"; marginMm: number };
  typography: { fontFamily: PayslipFontFamily; baseSizePt: number; headingCase: "upper" | "normal" };
  colors: { accent: string; text: string; zebraRows: boolean };
  header: {
    style: PayslipHeaderStyle;
    logo: PayslipLogoPosition;
    logoHeightMm: number;
    showCompanyName: boolean;
    title: string;
    subtitle: string;
    addressLines: string[];
    taxIds: string;
  };
  detailFields: PayslipDetailField[];
  detailColumns: 1 | 2 | 3;
  sections: PayslipDesignSection[];
  /** Earnings and deductions next to each other, or one under the other. */
  earningsDeductions: "sideBySide" | "stacked";
  lines: {
    showZeroLines: boolean;
    showQuantityAndRate: boolean;
    showTaxableMarker: boolean;
    decimals: 0 | 2;
    currency: "symbol" | "code" | "none";
  };
  summary: { emphasis: "box" | "line"; showGross: boolean; showDeductions: boolean };
  footer: {
    note: string;
    confidentialLabel: string;
    showGeneratedDate: boolean;
    employerSignature: boolean;
    employeeSignature: boolean;
    employerSignatureLabel: string;
    employeeSignatureLabel: string;
  };
  watermark: { text: string; opacityPct: number };
};

export type PayslipPrintDesignView = {
  design: PayslipPrintDesign;
  /** 0 while the company has never saved a design (the built-in default is in use); then 1, 2, ... */
  version: number;
  isDefault: boolean;
  updatedAt: string | null;
};

export const PAYSLIP_DESIGN_PRESETS = ["classic", "modern", "compact"] as const;
export type PayslipDesignPresetKey = (typeof PAYSLIP_DESIGN_PRESETS)[number];
export const PAYSLIP_DESIGN_PRESET_LABELS: Record<PayslipDesignPresetKey, { name: string; description: string }> = {
  classic: { name: "Classic", description: "Underlined header, serif type, details in two columns. Reads like a printed payslip." },
  modern: { name: "Modern", description: "Coloured header band, clean sans type, summary in a box, amount in words." },
  compact: { name: "Compact", description: "Small type and tight margins so it fits half a page. No signatures." },
};

export const DEFAULT_PAYSLIP_DESIGN: PayslipPrintDesign = {
  page: { size: "A4", orientation: "portrait", marginMm: 15 },
  typography: { fontFamily: "sans", baseSizePt: 10, headingCase: "upper" },
  colors: { accent: "#1d4ed8", text: "#111827", zebraRows: false },
  header: { style: "underline", logo: "left", logoHeightMm: 14, showCompanyName: true, title: "Payslip", subtitle: "", addressLines: [], taxIds: "" },
  detailFields: ["employeeName", "employeeNumber", "payrollPeriod", "payDate", "paidDays"],
  detailColumns: 2,
  sections: [
    { key: "details", enabled: true },
    { key: "earnings", enabled: true },
    { key: "deductions", enabled: true },
    { key: "employerContributions", enabled: false },
    { key: "summary", enabled: true },
    { key: "amountInWords", enabled: false },
    { key: "calculation", enabled: false },
    { key: "notes", enabled: true },
  ],
  earningsDeductions: "sideBySide",
  lines: { showZeroLines: false, showQuantityAndRate: false, showTaxableMarker: false, decimals: 2, currency: "symbol" },
  summary: { emphasis: "line", showGross: true, showDeductions: true },
  footer: {
    note: "This is a computer-generated payslip and does not require a signature.",
    confidentialLabel: "Confidential",
    showGeneratedDate: true,
    employerSignature: false,
    employeeSignature: false,
    employerSignatureLabel: "Authorised signatory",
    employeeSignatureLabel: "Employee signature",
  },
  watermark: { text: "", opacityPct: 8 },
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sectionsWith(enabled: PayslipSectionKey[], order?: PayslipSectionKey[]): PayslipDesignSection[] {
  const keys = order ?? [...PAYSLIP_SECTION_KEYS];
  return keys.map((key) => ({ key, enabled: enabled.includes(key) }));
}

/** A starting point for the editor; every value stays editable afterwards. */
export function payslipDesignPreset(key: PayslipDesignPresetKey): PayslipPrintDesign {
  const d = clone(DEFAULT_PAYSLIP_DESIGN);
  if (key === "classic") {
    d.typography = { fontFamily: "serif", baseSizePt: 10.5, headingCase: "upper" };
    d.colors = { accent: "#1f2937", text: "#111827", zebraRows: false };
    d.header.style = "underline";
    d.header.logo = "left";
    d.detailFields = ["employeeName", "employeeNumber", "payrollPeriod", "payDate", "paidDays"];
    d.detailColumns = 2;
    d.footer.employerSignature = true;
    d.footer.employeeSignature = true;
  } else if (key === "modern") {
    d.typography = { fontFamily: "sans", baseSizePt: 10, headingCase: "normal" };
    d.colors = { accent: "#0f766e", text: "#0f172a", zebraRows: true };
    d.header = { ...d.header, style: "band", logo: "left", logoHeightMm: 12 };
    d.detailFields = ["employeeName", "employeeNumber", "payrollPeriod", "payDate", "paidDays", "payrollType"];
    d.detailColumns = 3;
    d.summary.emphasis = "box";
    d.sections = sectionsWith(["details", "earnings", "deductions", "summary", "amountInWords", "notes"]);
  } else {
    d.page = { size: "A5", orientation: "landscape", marginMm: 8 };
    d.typography = { fontFamily: "sans", baseSizePt: 8.5, headingCase: "upper" };
    d.colors = { accent: "#374151", text: "#111827", zebraRows: false };
    d.header = { ...d.header, style: "plain", logo: "none", showCompanyName: true, title: "Payslip" };
    d.detailFields = ["employeeName", "employeeNumber", "payrollPeriod", "payDate", "paidDays"];
    d.detailColumns = 3;
    d.sections = sectionsWith(["details", "earnings", "deductions", "summary", "notes"]);
    d.lines.decimals = 0;
    d.footer.confidentialLabel = "";
  }
  return d;
}

export type PayslipDesignProblem = { path: string; message: string };

const HEX = /^#[0-9a-fA-F]{6}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns whatever was sent (or stored) into a complete design. Anything missing takes the default; anything present
 * but not allowed is reported in `problems` and the default is used for it. The API refuses to save a design with
 * problems; the editor shows them next to the field.
 */
export function normalizePayslipDesign(input: unknown): { design: PayslipPrintDesign; problems: PayslipDesignProblem[] } {
  const problems: PayslipDesignProblem[] = [];
  const d = clone(DEFAULT_PAYSLIP_DESIGN);
  const raw = isObject(input) ? input : {};
  if (input !== undefined && input !== null && !isObject(input)) problems.push({ path: "", message: "The design must be an object." });

  const pick = <T extends string>(path: string, value: unknown, allowed: readonly T[], fallback: T): T => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    problems.push({ path, message: `Must be one of: ${allowed.join(", ")}.` });
    return fallback;
  };
  const bool = (path: string, value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    problems.push({ path, message: "Must be true or false." });
    return fallback;
  };
  const num = (path: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
    problems.push({ path, message: `Must be a number from ${min} to ${max}.` });
    return fallback;
  };
  const text = (path: string, value: unknown, max: number, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return value.trim();
    problems.push({ path, message: `Must be text of at most ${max} characters.` });
    return fallback;
  };
  const color = (path: string, value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && HEX.test(value)) return value.toLowerCase();
    problems.push({ path, message: "Must be a colour like #1d4ed8." });
    return fallback;
  };
  const section = (name: string): Record<string, unknown> => {
    const v = raw[name];
    if (v === undefined) return {};
    if (isObject(v)) return v;
    problems.push({ path: name, message: "Must be an object." });
    return {};
  };

  const page = section("page");
  d.page.size = pick("page.size", page.size, PAYSLIP_PAPER_SIZES, d.page.size);
  d.page.orientation = pick("page.orientation", page.orientation, ["portrait", "landscape"] as const, d.page.orientation);
  d.page.marginMm = num("page.marginMm", page.marginMm, 5, 30, d.page.marginMm);

  const typo = section("typography");
  d.typography.fontFamily = pick("typography.fontFamily", typo.fontFamily, PAYSLIP_FONT_FAMILIES, d.typography.fontFamily);
  d.typography.baseSizePt = num("typography.baseSizePt", typo.baseSizePt, 7, 13, d.typography.baseSizePt);
  d.typography.headingCase = pick("typography.headingCase", typo.headingCase, ["upper", "normal"] as const, d.typography.headingCase);

  const colors = section("colors");
  d.colors.accent = color("colors.accent", colors.accent, d.colors.accent);
  d.colors.text = color("colors.text", colors.text, d.colors.text);
  d.colors.zebraRows = bool("colors.zebraRows", colors.zebraRows, d.colors.zebraRows);

  const header = section("header");
  d.header.style = pick("header.style", header.style, PAYSLIP_HEADER_STYLES, d.header.style);
  d.header.logo = pick("header.logo", header.logo, PAYSLIP_LOGO_POSITIONS, d.header.logo);
  d.header.logoHeightMm = num("header.logoHeightMm", header.logoHeightMm, 6, 30, d.header.logoHeightMm);
  d.header.showCompanyName = bool("header.showCompanyName", header.showCompanyName, d.header.showCompanyName);
  d.header.title = text("header.title", header.title, 40, d.header.title);
  d.header.subtitle = text("header.subtitle", header.subtitle, 120, d.header.subtitle);
  d.header.taxIds = text("header.taxIds", header.taxIds, 120, d.header.taxIds);
  if (header.addressLines !== undefined) {
    if (Array.isArray(header.addressLines) && header.addressLines.length <= 4 && header.addressLines.every((l) => typeof l === "string" && l.length <= 100)) {
      d.header.addressLines = (header.addressLines as string[]).map((l) => l.trim()).filter((l) => l.length > 0);
    } else {
      problems.push({ path: "header.addressLines", message: "Must be up to 4 lines of at most 100 characters." });
    }
  }

  if (raw.detailFields !== undefined) {
    const f = raw.detailFields;
    if (Array.isArray(f) && f.length <= PAYSLIP_DETAIL_FIELDS.length && f.every((x) => (PAYSLIP_DETAIL_FIELDS as readonly unknown[]).includes(x)) && new Set(f).size === f.length) {
      d.detailFields = f as PayslipDetailField[];
    } else {
      problems.push({ path: "detailFields", message: `Must list each of ${PAYSLIP_DETAIL_FIELDS.join(", ")} at most once.` });
    }
  }
  if (raw.detailColumns !== undefined) {
    if (raw.detailColumns === 1 || raw.detailColumns === 2 || raw.detailColumns === 3) d.detailColumns = raw.detailColumns;
    else problems.push({ path: "detailColumns", message: "Must be 1, 2 or 3." });
  }

  if (raw.sections !== undefined) {
    const s = raw.sections;
    const valid =
      Array.isArray(s) &&
      s.length === PAYSLIP_SECTION_KEYS.length &&
      s.every((x) => isObject(x) && typeof x.enabled === "boolean" && (PAYSLIP_SECTION_KEYS as readonly unknown[]).includes(x.key)) &&
      new Set((s as Array<{ key: string }>).map((x) => x.key)).size === PAYSLIP_SECTION_KEYS.length;
    if (valid) d.sections = (s as PayslipDesignSection[]).map((x) => ({ key: x.key, enabled: x.enabled }));
    else problems.push({ path: "sections", message: "Must list every block exactly once, each with enabled true or false." });
  }

  d.earningsDeductions = pick("earningsDeductions", raw.earningsDeductions, ["sideBySide", "stacked"] as const, d.earningsDeductions);

  const lines = section("lines");
  d.lines.showZeroLines = bool("lines.showZeroLines", lines.showZeroLines, d.lines.showZeroLines);
  d.lines.showQuantityAndRate = bool("lines.showQuantityAndRate", lines.showQuantityAndRate, d.lines.showQuantityAndRate);
  d.lines.showTaxableMarker = bool("lines.showTaxableMarker", lines.showTaxableMarker, d.lines.showTaxableMarker);
  d.lines.currency = pick("lines.currency", lines.currency, ["symbol", "code", "none"] as const, d.lines.currency);
  if (lines.decimals !== undefined) {
    if (lines.decimals === 0 || lines.decimals === 2) d.lines.decimals = lines.decimals;
    else problems.push({ path: "lines.decimals", message: "Must be 0 or 2." });
  }

  const summary = section("summary");
  d.summary.emphasis = pick("summary.emphasis", summary.emphasis, ["box", "line"] as const, d.summary.emphasis);
  d.summary.showGross = bool("summary.showGross", summary.showGross, d.summary.showGross);
  d.summary.showDeductions = bool("summary.showDeductions", summary.showDeductions, d.summary.showDeductions);

  const footer = section("footer");
  d.footer.note = text("footer.note", footer.note, 300, d.footer.note);
  d.footer.confidentialLabel = text("footer.confidentialLabel", footer.confidentialLabel, 40, d.footer.confidentialLabel);
  d.footer.showGeneratedDate = bool("footer.showGeneratedDate", footer.showGeneratedDate, d.footer.showGeneratedDate);
  d.footer.employerSignature = bool("footer.employerSignature", footer.employerSignature, d.footer.employerSignature);
  d.footer.employeeSignature = bool("footer.employeeSignature", footer.employeeSignature, d.footer.employeeSignature);
  d.footer.employerSignatureLabel = text("footer.employerSignatureLabel", footer.employerSignatureLabel, 40, d.footer.employerSignatureLabel);
  d.footer.employeeSignatureLabel = text("footer.employeeSignatureLabel", footer.employeeSignatureLabel, 40, d.footer.employeeSignatureLabel);

  const wm = section("watermark");
  d.watermark.text = text("watermark.text", wm.text, 30, d.watermark.text);
  d.watermark.opacityPct = num("watermark.opacityPct", wm.opacityPct, 3, 20, d.watermark.opacityPct);

  return { design: d, problems };
}

/** The CSS font stack for each choice. No web fonts: a payslip must print the same on any computer. */
export const PAYSLIP_FONT_STACKS: Record<PayslipFontFamily, string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  humanist: "'Trebuchet MS', 'Segoe UI', Verdana, Geneva, sans-serif",
  mono: "'Courier New', Courier, monospace",
};

export const PAYSLIP_PAPER_MM: Record<PayslipPaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
};

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
}
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/**
 * An amount in words the way Pakistani payslips and cheques write it (crore, lakh, thousand):
 * 1250075.5 -> "Rupees Twelve Lakh Fifty Thousand Seventy-Five and Paisa Fifty Only". Never throws.
 */
export function amountInWordsPKR(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const negative = amount < 0;
  const cents = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(cents / 100);
  const paisa = cents % 100;
  const parts: string[] = [];
  let rest = rupees;
  const crore = Math.floor(rest / 10000000);
  rest %= 10000000;
  const lakh = Math.floor(rest / 100000);
  rest %= 100000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (crore) parts.push(`${crore >= 100 ? belowThousand(crore) : belowHundred(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  const rupeeWords = parts.length ? parts.join(" ") : "Zero";
  const paisaWords = paisa ? ` and Paisa ${belowHundred(paisa)}` : "";
  return `${negative ? "Minus " : ""}Rupees ${rupeeWords}${paisaWords} Only`;
}
