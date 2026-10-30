import { useEffect, useState } from "react";
import type { FormLayoutView } from "@aihxm/shared-types";
import { api } from "../../api/client";

/**
 * The company's designed layout for one form (sections, order, extra fields, conditions). Until it loads, or when none is published,
 * `layout` is null and the form draws exactly as it always did. The server applies the same rules when the form is sent.
 */
export function useFormLayout(formKey: string): FormLayoutView | null {
  const [view, setView] = useState<FormLayoutView | null>(null);
  useEffect(() => {
    let alive = true;
    api.getFormLayout(formKey).then((v) => { if (alive) setView(v); }).catch(() => undefined);
    return () => { alive = false; };
  }, [formKey]);
  return view;
}
