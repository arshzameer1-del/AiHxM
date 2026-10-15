import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { ReviewCyclePhaseView, ReviewPhaseKey } from "@aihxm/shared-types";
import { REVIEW_PHASE_KEYS } from "@aihxm/shared-types";

export const PHASE_LABELS: Record<ReviewPhaseKey, string> = {
  goal_setting: "goal-setting",
  self_assessment: "self-assessment",
  manager_assessment: "manager-assessment",
  calibration: "calibration",
  release: "release",
};

/** Today's date in the company's time zone, as yyyy-mm-dd. */
export async function tenantToday(client: PoolClient, companyId: string | null | undefined): Promise<string> {
  const r = await client.query<{ d: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE((SELECT timezone FROM companies WHERE id = $1), 'UTC'))::date, 'YYYY-MM-DD') AS d`,
    [companyId ?? null]
  );
  return r.rows[0].d;
}

function iso(v: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x = v as any;
  if (typeof x === "string") return x.slice(0, 10);
  return x?.toISOString ? x.toISOString().slice(0, 10) : String(x);
}

export function phaseState(today: string, startsOn: string, endsOn: string): ReviewCyclePhaseView["state"] {
  if (today < startsOn) return "upcoming";
  if (today > endsOn) return "closed";
  return "open";
}

export async function loadPhases(client: PoolClient, cycleIds: string[], today: string): Promise<Map<string, ReviewCyclePhaseView[]>> {
  const out = new Map<string, ReviewCyclePhaseView[]>();
  if (cycleIds.length === 0) return out;
  const r = await client.query(
    `SELECT review_cycle_id, phase_key, starts_on, ends_on FROM review_cycle_phases WHERE review_cycle_id = ANY($1::uuid[])`,
    [cycleIds]
  );
  for (const row of r.rows) {
    const list = out.get(row.review_cycle_id) ?? [];
    const startsOn = iso(row.starts_on);
    const endsOn = iso(row.ends_on);
    list.push({ phaseKey: row.phase_key, startsOn, endsOn, state: phaseState(today, startsOn, endsOn) });
    out.set(row.review_cycle_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => REVIEW_PHASE_KEYS.indexOf(a.phaseKey) - REVIEW_PHASE_KEYS.indexOf(b.phaseKey));
  return out;
}

/** The latest phase that has started and whose window is still open (or, failing that, the most recently started). */
export function currentPhase(phases: ReviewCyclePhaseView[]): ReviewPhaseKey | null {
  const open = phases.filter((p) => p.state === "open");
  if (open.length > 0) return open[open.length - 1].phaseKey;
  const started = phases.filter((p) => p.state === "closed");
  return started.length > 0 ? started[started.length - 1].phaseKey : null;
}

/**
 * TAL-07: refuses work outside the phase window. A cycle with no windows (or none for this phase) is unrestricted, and
 * HR (`bypass`) may always act - their action is audited by the caller.
 */
export async function assertPhaseOpen(
  client: PoolClient,
  companyId: string | null | undefined,
  cycleId: string,
  phaseKey: ReviewPhaseKey,
  bypass: boolean
): Promise<void> {
  if (bypass) return;
  const r = await client.query(`SELECT starts_on, ends_on FROM review_cycle_phases WHERE review_cycle_id = $1 AND phase_key = $2`, [cycleId, phaseKey]);
  if (r.rowCount === 0) return;
  const today = await tenantToday(client, companyId);
  const startsOn = iso(r.rows[0].starts_on);
  const endsOn = iso(r.rows[0].ends_on);
  const state = phaseState(today, startsOn, endsOn);
  if (state === "upcoming") throw new BadRequestException(`The ${PHASE_LABELS[phaseKey]} window opens on ${startsOn}.`);
  if (state === "closed") throw new BadRequestException(`The ${PHASE_LABELS[phaseKey]} window closed on ${endsOn}. Ask HR if it needs to be extended.`);
}

/** Phases must follow the cycle's order: a later phase may not start or end before an earlier one does. */
export function validatePhaseSet(phases: Array<{ phaseKey: string; startsOn: string; endsOn: string }>): void {
  const seen = new Set<string>();
  for (const p of phases) {
    if (!REVIEW_PHASE_KEYS.includes(p.phaseKey as ReviewPhaseKey)) throw new BadRequestException(`Unknown phase "${p.phaseKey}"`);
    if (seen.has(p.phaseKey)) throw new BadRequestException(`Phase "${p.phaseKey}" is listed twice`);
    seen.add(p.phaseKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startsOn) || !/^\d{4}-\d{2}-\d{2}$/.test(p.endsOn)) throw new BadRequestException("Phase dates must be yyyy-mm-dd");
    if (p.endsOn < p.startsOn) throw new BadRequestException(`The ${PHASE_LABELS[p.phaseKey as ReviewPhaseKey]} phase cannot end before it starts`);
  }
  const ordered = [...phases].sort((a, b) => REVIEW_PHASE_KEYS.indexOf(a.phaseKey as ReviewPhaseKey) - REVIEW_PHASE_KEYS.indexOf(b.phaseKey as ReviewPhaseKey));
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.startsOn < prev.startsOn || cur.endsOn < prev.endsOn) {
      throw new BadRequestException(
        `The ${PHASE_LABELS[cur.phaseKey as ReviewPhaseKey]} phase cannot start or end before the ${PHASE_LABELS[prev.phaseKey as ReviewPhaseKey]} phase does.`
      );
    }
  }
}
