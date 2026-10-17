/**
 * Orders employee numbers the way people read them: by the number inside (EMP-0003 before EMP-0019, EMP1002 after both),
 * then by the letters in front. Plain text order puts EMP-0019 after EMP1002 and EMP-10 before EMP-9.
 */
export function compareEmployeeNumbers(a: string, b: string): number {
  const na = Number((a.match(/\d+/) ?? ["0"])[0]);
  const nb = Number((b.match(/\d+/) ?? ["0"])[0]);
  if (na !== nb) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}
