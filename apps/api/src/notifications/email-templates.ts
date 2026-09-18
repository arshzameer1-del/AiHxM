/**
 * A small, explicit map from `templateKey` to a real email subject/body —
 * deliberately NOT a generic templating engine (no Handlebars, no string
 * interpolation library): every template this codebase actually sends is
 * listed here by name, so a typo'd or future `templateKey` falls through
 * to a generic, still-legible rendering rather than throwing or silently
 * sending a blank email. This is a plain, framework-light lookup table,
 * matching the "clean bounded engines, not one generic engine" directive —
 * a real Dynamic Form/Notification templating system (per-tenant,
 * admin-editable templates) is a separate, later gap (see
 * claude/aihxm-master-audit-and-roadmap.md's Notification Engine row),
 * not attempted here.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
}

type TemplateRenderer = (payload: Record<string, unknown>) => RenderedEmail;

const TEMPLATES: Record<string, TemplateRenderer> = {
  password_reset: (payload) => ({
    subject: "Reset your BoostFactor password",
    text: [
      "We received a request to reset your BoostFactor password.",
      "",
      `Reset it here: ${payload.resetLink ?? ""}`,
      "",
      "This link expires shortly. If you didn't request this, you can safely ignore this email — your password hasn't been changed.",
    ].join("\n"),
  }),
};

/** Every template not explicitly listed above still gets a real, legible email — never a throw, never a blank body. */
function renderGeneric(templateKey: string, payload: Record<string, unknown>): RenderedEmail {
  const lines = Object.entries(payload).map(([key, value]) => `${key}: ${String(value)}`);
  return {
    subject: `BoostFactor notification: ${templateKey}`,
    text: lines.length > 0 ? lines.join("\n") : "(no additional details)",
  };
}

export function renderEmailTemplate(templateKey: string, payload: Record<string, unknown>): RenderedEmail {
  const renderer = TEMPLATES[templateKey];
  return renderer ? renderer(payload) : renderGeneric(templateKey, payload);
}
