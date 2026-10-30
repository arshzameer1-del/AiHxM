import { useEffect, useState } from "react";
import type { FormFieldSettingView } from "@aihxm/shared-types";
import { api } from "../../api/client";

export type FieldSetting = Pick<FormFieldSettingView, "label" | "helpText" | "placeholder" | "hidden" | "required" | "maxLength">;

/**
 * The company's settings for one form (label, help text, required, hidden, length limit). Until they load, or if they cannot be loaded,
 * every field behaves as the form's own default, so a form never waits on, or breaks because of, its settings.
 * The server applies the same settings when the form is sent, so this only decides how the form is drawn.
 */
export function useFormSettings(formKey: string) {
  const [fields, setFields] = useState<Record<string, FormFieldSettingView>>({});
  useEffect(() => {
    let alive = true;
    api.getFormSettings(formKey).then((f) => { if (alive) setFields(Object.fromEntries(f.fields.map((x) => [x.fieldKey, x]))); }).catch(() => undefined);
    return () => { alive = false; };
  }, [formKey]);
  /** The setting for a field, or the given defaults while nothing is loaded. */
  return (fieldKey: string, fallback: { label: string; required?: boolean }): FieldSetting => {
    const f = fields[fieldKey];
    return f
      ? { label: f.label, helpText: f.helpText, placeholder: f.placeholder, hidden: f.hidden, required: f.required, maxLength: f.maxLength }
      : { label: fallback.label, helpText: null, placeholder: null, hidden: false, required: fallback.required ?? false, maxLength: null };
  };
}
