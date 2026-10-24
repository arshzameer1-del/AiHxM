import { useEffect, useRef, useState } from "react";
import { useEmployeePhoto } from "../employees/employeePhoto";
import { initialsFromName } from "./initials";

const SIZES = { xs: "h-6 w-6 text-[10px]", sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-14 w-14 text-lg", fill: "h-full w-full text-lg" } as const;

/**
 * BACKLOG59 - the one round picture used wherever a person is listed (org chart, employee list, approvals, team
 * calendar, attendance ...). It shows the employee's approved profile photo and falls back to initials when there is
 * none. The photo is only requested once the avatar scrolls into view, so a long list does not fire hundreds of
 * requests at once, and every avatar of the same person shares one download.
 */
export function EmployeeAvatar({
  employeeId,
  name,
  size = "sm",
  className = "",
  tone = "soft",
}: {
  employeeId: string | null | undefined;
  name: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
  tone?: "soft" | "solid";
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const url = useEmployeePhoto(near ? employeeId : null);
  const colour = tone === "solid" ? "bg-accent text-white" : "bg-accent/15 text-accent";
  return (
    <span
      ref={ref}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${SIZES[size]} ${url ? "" : colour} ${className}`}
      data-testid="employee-avatar"
      data-has-photo={url ? "true" : "false"}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" /> : initialsFromName(name)}
    </span>
  );
}
