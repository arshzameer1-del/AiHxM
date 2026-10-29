import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  DecideTravelRequestRequest, IssueTravelAdvanceRequest, SettleTravelRequest, SubmitTravelRequestRequest, TravelMode, TravelRateView, TravelRequestView, TravelSettlementView,
  TravelStatus, TravelTripType, UpsertTravelRateRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";
import { WorkflowService } from "../workflow/workflow.service";
import { decideInEngine, statusForOutcome, submitToEngineIfConfigured } from "../workflow/engine-routing";

const OBJECT_KEY = "travel_request";
const MODES: TravelMode[] = ["air", "car", "bus", "train", "other"];
const TRIPS: TravelTripType[] = ["domestic", "international"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const iso = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10));
const isoTs = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const money = (n: number) => Math.round(n * 100) / 100;

/** Days from start to end, both included. */
export function tripDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

/** The settlement arithmetic in one place: per diem for the days, mileage for the distance, other costs, minus the advance already paid. */
export function computeSettlement(i: { days: number; km: number; otherCost: number; advance: number; perDiemRate: number | null; mileageRate: number | null }): Omit<TravelSettlementView, "actualDays" | "actualKm" | "otherCostNote"> {
  const perDiemAmount = money(i.days * (i.perDiemRate ?? 0));
  const mileageAmount = money(i.km * (i.mileageRate ?? 0));
  const totalCost = money(perDiemAmount + mileageAmount + i.otherCost);
  return { perDiemRate: i.perDiemRate, mileageRate: i.mileageRate, perDiemAmount, mileageAmount, otherCost: money(i.otherCost), totalCost, advanceAmount: money(i.advance), netAmount: money(totalCost - i.advance) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rateView(x: any): TravelRateView {
  return { id: x.id, name: x.name, rateKind: x.rate_kind, tripType: x.trip_type, amount: Number(x.amount), isActive: x.is_active };
}

/**
 * Business travel. A trip is asked for ahead of time and approved like an on-duty request (manager, HR or a configured workflow).
 * HR can then pay an advance through payroll, and after the trip settles it: per diem and mileage from the company's own rates plus
 * other costs, less the advance. A positive balance is paid and a negative one recovered, both as payroll additional payments, so
 * nothing moves money except HR and payroll, and the settlement is a number HR can read before it is saved.
 */
@Injectable()
export class TravelService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly payments: EmployeeAdditionalPaymentsService,
    private readonly workflow?: WorkflowService,
    private readonly inbox?: UserNotificationsService
  ) {
    this.workflow?.adapters?.register({
      objectKey: OBJECT_KEY,
      label: "Travel request",
      canSendBack: true,
      describe: async (client, recordId) => {
        const r = await client.query(
          `SELECT t.destination, t.start_date, t.end_date, e.first_name, e.last_name FROM travel_requests t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
          [recordId]
        );
        if (!r.rowCount) return null;
        const x = r.rows[0];
        return { title: `Travel: ${x.first_name} ${x.last_name} to ${x.destination}`, summary: `${iso(x.start_date)} to ${iso(x.end_date)}`, deepLink: "/app/travel" };
      },
      onOutcome: async (ctx) => {
        const status = statusForOutcome(ctx.event);
        const decided = status === "approved" || status === "rejected";
        const r = await ctx.client.query(
          `UPDATE travel_requests
              SET status = $2, updated_at = now(),
                  decided_by_user_account_id = CASE WHEN $3 THEN $4::uuid ELSE decided_by_user_account_id END,
                  decision_comment = CASE WHEN $3 THEN $5 ELSE decision_comment END,
                  decided_at = CASE WHEN $3 THEN now() ELSE decided_at END
            WHERE id = $1 AND status NOT IN ('settled') RETURNING employee_id`,
          [ctx.recordId, status, decided, ctx.claims.sub, ctx.comment]
        );
        if (!r.rowCount) return;
        await this.audit.record(ctx.client, ctx.claims, { companyId: ctx.claims.company_id ?? null, action: `travel.${ctx.event}`, target: ctx.recordId, metadata: { viaWorkflow: ctx.instanceId } });
      },
    });
  }

  // ------------------------------------------------------------------ rates

  async listRates(claims: RequestClaims): Promise<TravelRateView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "travel.manage")) && !(await this.rbac.can(claims, "travel.request.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to see travel rates");
    return this.db.withClaims(claims, async (c) => (await c.query("SELECT * FROM travel_rates ORDER BY rate_kind, trip_type, name")).rows.map(rateView));
  }

  async saveRate(claims: RequestClaims, id: string | null, input: UpsertTravelRateRequest): Promise<TravelRateView> {
    await this.requireManage(claims);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 80) throw new BadRequestException("Enter a rate name of up to 80 characters");
    if (!["per_diem", "mileage"].includes(input.rateKind)) throw new BadRequestException("Choose per diem or mileage");
    if (!TRIPS.includes(input.tripType)) throw new BadRequestException("Choose domestic or international");
    if (!(Number(input.amount) > 0)) throw new BadRequestException("The amount must be more than zero");
    return this.db.withClaims(claims, async (c) => {
      const companyId = claims.company_id as string;
      const clash = await c.query("SELECT 1 FROM travel_rates WHERE company_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)", [companyId, name, id]);
      if (clash.rowCount) throw new ConflictException("A rate with that name already exists");
      let r;
      if (id) {
        r = await c.query("UPDATE travel_rates SET name=$2, rate_kind=$3, trip_type=$4, amount=$5, is_active=COALESCE($6, is_active) WHERE id=$1 RETURNING *", [id, name, input.rateKind, input.tripType, input.amount, input.isActive ?? null]);
        if (!r.rowCount) throw new NotFoundException("Rate not found");
      } else {
        r = await c.query("INSERT INTO travel_rates (company_id, name, rate_kind, trip_type, amount, is_active) VALUES ($1,$2,$3,$4,$5,COALESCE($6,true)) RETURNING *", [companyId, name, input.rateKind, input.tripType, input.amount, input.isActive ?? null]);
      }
      await this.audit.record(c, claims, { companyId, action: id ? "travel.rate_update" : "travel.rate_create", target: r.rows[0].id, metadata: { name, amount: input.amount } });
      return rateView(r.rows[0]);
    });
  }

  /** The rate in force for a kind and trip type: the most recently added active one. */
  private async currentRate(client: PoolClient, kind: "per_diem" | "mileage", trip: string): Promise<number | null> {
    const r = await client.query("SELECT amount FROM travel_rates WHERE rate_kind = $1 AND trip_type = $2 AND is_active ORDER BY created_at DESC LIMIT 1", [kind, trip]);
    return r.rowCount ? Number(r.rows[0].amount) : null;
  }

  // ------------------------------------------------------------------ requests

  async submit(claims: RequestClaims, input: SubmitTravelRequestRequest): Promise<TravelRequestView> {
    await this.requireModule(claims);
    const destination = (input.destination ?? "").trim();
    const purpose = (input.purpose ?? "").trim();
    if (!destination || destination.length > 160) throw new BadRequestException("Enter where you are travelling to");
    if (!purpose || purpose.length > 1000) throw new BadRequestException("Say what the trip is for");
    if (!DATE_RE.test(input.startDate ?? "") || !DATE_RE.test(input.endDate ?? "")) throw new BadRequestException("Enter valid dates");
    if (input.endDate < input.startDate) throw new BadRequestException("The trip cannot end before it starts");
    if (tripDays(input.startDate, input.endDate) > 90) throw new BadRequestException("A single travel request can cover up to 90 days");
    if (input.startDate < localToday()) throw new BadRequestException("Travel is asked for before the trip starts");
    const trip = input.tripType ?? "domestic";
    const mode = input.travelMode ?? "other";
    if (!TRIPS.includes(trip)) throw new BadRequestException("Choose domestic or international");
    if (!MODES.includes(mode)) throw new BadRequestException("Choose how you will travel");
    for (const [label, v] of [["distance", input.estDistanceKm], ["other costs", input.estOtherCost], ["advance", input.advanceRequested]] as const) {
      if (v !== null && v !== undefined && !(Number(v) >= 0)) throw new BadRequestException(`The ${label} cannot be negative`);
    }

    return this.db.withClaims(claims, async (client) => {
      const e = await this.employee(client, input.employeeId);
      const isSelf = e.user_account_id === claims.sub;
      const allowed = isSelf ? await this.rbac.can(claims, "travel.request.self", { ownerId: e.user_account_id }) : await this.rbac.can(claims, "travel.manage");
      if (!allowed) throw new ForbiddenException("Not permitted to request travel for this employee");
      const overlap = await client.query(
        `SELECT 1 FROM travel_requests WHERE employee_id = $1 AND status IN ('pending', 'approved', 'returned') AND start_date <= $2 AND end_date >= $3`,
        [e.id, input.endDate, input.startDate]
      );
      if (overlap.rowCount) throw new ConflictException("This employee already has a travel request for these dates");
      const ins = await client.query(
        `INSERT INTO travel_requests (company_id, employee_id, destination, purpose, trip_type, travel_mode, start_date, end_date, est_distance_km, est_other_cost, advance_requested, submitted_by_user_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [e.company_id, e.id, destination, purpose, trip, mode, input.startDate, input.endDate, input.estDistanceKm ?? null, input.estOtherCost ?? null, input.advanceRequested ?? 0, claims.sub]
      );
      const id = ins.rows[0].id as string;
      await submitToEngineIfConfigured(this.workflow, client, claims, {
        objectKey: OBJECT_KEY, table: "travel_requests", recordId: id,
        record: { employeeId: e.id, destination, tripType: trip, startDate: input.startDate, endDate: input.endDate, advanceRequested: Number(input.advanceRequested ?? 0) },
        subjectUserAccountId: e.user_account_id, title: `Travel: ${e.first_name} ${e.last_name} to ${destination}`,
      });
      await this.audit.record(client, claims, { companyId: e.company_id, action: "travel.submit", target: id, metadata: { employeeId: e.id, destination } });
      return this.view(client, id);
    });
  }

  async listMine(claims: RequestClaims): Promise<TravelRequestView[]> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "travel.request.self", { ownerId: claims.sub }))) throw new ForbiddenException("Not permitted to see travel requests");
    return this.db.withClaims(claims, async (client) => {
      const ids = await client.query("SELECT t.id FROM travel_requests t JOIN employees e ON e.id = t.employee_id WHERE e.user_account_id = $1 ORDER BY t.start_date DESC LIMIT 200", [claims.sub]);
      return this.views(client, ids.rows.map((r) => r.id));
    });
  }

  /** HR: every trip, optionally by status. */
  async listAll(claims: RequestClaims, status?: string): Promise<TravelRequestView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const ids = await client.query("SELECT id FROM travel_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY start_date DESC LIMIT 500", [status || null]);
      return this.views(client, ids.rows.map((r) => r.id));
    });
  }

  /** A manager's or HR's waiting list. Requests routed through a workflow appear in Approvals instead. */
  async listPending(claims: RequestClaims): Promise<TravelRequestView[]> {
    await this.requireModule(claims);
    const scope = await this.rbac.resolveViewScope(claims, "travel.decide");
    if (!scope.hasAll && !scope.hasTeam) return [];
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT t.id, m.user_account_id AS manager_user FROM travel_requests t JOIN employees e ON e.id = t.employee_id LEFT JOIN employees m ON m.id = e.manager_id
          WHERE t.status = 'pending' AND t.workflow_instance_id IS NULL ORDER BY t.created_at`
      );
      const mine = scope.hasAll ? r.rows : r.rows.filter((x) => x.manager_user === claims.sub);
      return this.views(client, mine.map((x) => x.id));
    });
  }

  async decide(claims: RequestClaims, id: string, input: DecideTravelRequestRequest): Promise<TravelRequestView> {
    await this.requireModule(claims);
    if (!["approved", "rejected"].includes(input.decision)) throw new BadRequestException("Choose approve or reject");
    const out = await this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT t.*, e.user_account_id AS emp_user, e.manager_id FROM travel_requests t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1 FOR UPDATE OF t`,
        [id]
      );
      if (!r.rowCount) throw new NotFoundException("Travel request not found");
      const t = r.rows[0];
      if (t.status !== "pending") throw new ConflictException("This travel request has already been decided");
      if (t.workflow_instance_id && this.workflow) {
        await decideInEngine(this.workflow, client, claims, t.workflow_instance_id, { decision: input.decision, comment: input.comment });
      } else {
        const managerUser = t.manager_id ? (await client.query("SELECT user_account_id FROM employees WHERE id = $1", [t.manager_id])).rows[0]?.user_account_id ?? null : null;
        const canAll = await this.rbac.can(claims, "travel.decide.all");
        const canTeam = await this.rbac.can(claims, "travel.decide.team", { teamOwnerId: managerUser });
        if (!canAll && !canTeam) throw new ForbiddenException("Not permitted to decide this travel request");
        if (t.emp_user === claims.sub) throw new ForbiddenException("You cannot decide your own travel request");
        await client.query(
          "UPDATE travel_requests SET status = $2, decided_by_user_account_id = $3, decision_comment = $4, decided_at = now(), updated_at = now() WHERE id = $1",
          [id, input.decision, claims.sub, input.comment?.trim().slice(0, 1000) || null]
        );
        await this.audit.record(client, claims, { companyId: t.company_id, action: `travel.${input.decision}`, target: id });
      }
      return { view: await this.view(client, id), userId: t.emp_user as string | null, companyId: t.company_id as string, destination: t.destination as string };
    });
    await this.tell(out.companyId, out.userId, `Travel request ${out.view.status === "approved" ? "approved" : "not approved"}: ${out.destination}`, input.comment?.trim() || "Open Travel to see the details.");
    return out.view;
  }

  /** The traveller (or HR) withdraws a trip. An advance that has not gone through payroll yet is cancelled with it. */
  async cancel(claims: RequestClaims, id: string): Promise<TravelRequestView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT t.*, e.user_account_id AS emp_user FROM travel_requests t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1 FOR UPDATE OF t", [id]);
      if (!r.rowCount) throw new NotFoundException("Travel request not found");
      const t = r.rows[0];
      const own = t.emp_user === claims.sub && (await this.rbac.can(claims, "travel.request.self", { ownerId: t.emp_user }));
      if (!own && !(await this.rbac.can(claims, "travel.manage"))) throw new ForbiddenException("Not permitted to cancel this travel request");
      if (!["pending", "approved", "returned"].includes(t.status)) throw new ConflictException(t.status === "settled" ? "This trip is already settled" : "This travel request is already closed");
      if (t.advance_payment_id) {
        const p = await client.query("SELECT status FROM employee_additional_payments WHERE id = $1", [t.advance_payment_id]);
        if (p.rows[0]?.status === "consumed") throw new ConflictException("The advance has already been paid in payroll. Settle the trip instead, so the advance is recovered");
        // the traveller may withdraw their own trip, so the queued advance is cancelled here rather than through the HR-only payments screen
        if (p.rows[0]?.status === "pending") await client.query("UPDATE employee_additional_payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [t.advance_payment_id]);
      }
      await client.query("UPDATE travel_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: t.company_id, action: "travel.cancel", target: id });
      return this.view(client, id);
    });
  }

  /** HR: pay an advance through payroll. Once, and no more than the traveller asked for. */
  async issueAdvance(claims: RequestClaims, id: string, input: IssueTravelAdvanceRequest): Promise<TravelRequestView> {
    await this.requireManage(claims);
    const amount = money(Number(input.amount));
    if (!(amount > 0)) throw new BadRequestException("The advance must be more than zero");
    const prep = await this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM travel_requests WHERE id = $1 FOR UPDATE", [id]);
      if (!r.rowCount) throw new NotFoundException("Travel request not found");
      const t = r.rows[0];
      if (t.status !== "approved") throw new ConflictException("An advance can only be paid for an approved trip");
      if (t.advance_payment_id) throw new ConflictException("An advance was already issued for this trip");
      if (amount > Number(t.advance_requested)) throw new BadRequestException(Number(t.advance_requested) > 0 ? `The traveller asked for an advance of up to ${Number(t.advance_requested)}` : "The traveller did not ask for an advance");
      return t;
    });
    const pay = await this.payments.create(claims, {
      employeeId: prep.employee_id, paymentType: "earning", label: `Travel advance: ${prep.destination}`, amount, isTaxable: false,
      effectiveDate: localToday(), reasonNote: `Advance for the trip ${iso(prep.start_date)} to ${iso(prep.end_date)}`,
    });
    return this.db.withClaims(claims, async (client) => {
      await client.query("UPDATE travel_requests SET advance_amount = $2, advance_payment_id = $3, advance_issued_at = now(), updated_at = now() WHERE id = $1", [id, amount, pay.id]);
      await this.audit.record(client, claims, { companyId: prep.company_id, action: "travel.advance", target: id, metadata: { amount } });
      return this.view(client, id);
    });
  }

  /** What settling would give, without saving anything. */
  async previewSettlement(claims: RequestClaims, id: string, input: SettleTravelRequest): Promise<TravelSettlementView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const t = await this.loadForSettlement(client, id);
      return this.settlementFor(client, t, input);
    });
  }

  /** HR: close the trip. The balance is paid, or recovered, through payroll. */
  async settle(claims: RequestClaims, id: string, input: SettleTravelRequest): Promise<TravelRequestView> {
    await this.requireManage(claims);
    const prep = await this.db.withClaims(claims, async (client) => {
      const t = await this.loadForSettlement(client, id);
      const s = await this.settlementFor(client, t, input);
      // claim the trip first so two clicks cannot pay twice
      await client.query(
        `UPDATE travel_requests SET status = 'settled', settled_at = now(), settled_by_user_account_id = $2, actual_days = $3, actual_km = $4, per_diem_rate = $5, mileage_rate = $6,
                per_diem_amount = $7, mileage_amount = $8, other_cost = $9, other_cost_note = $10, total_cost = $11, net_amount = $12, updated_at = now() WHERE id = $1`,
        [id, claims.sub, s.actualDays, s.actualKm, s.perDiemRate, s.mileageRate, s.perDiemAmount, s.mileageAmount, s.otherCost, s.otherCostNote, s.totalCost, s.netAmount]
      );
      await this.audit.record(client, claims, { companyId: t.company_id, action: "travel.settle", target: id, metadata: { net: s.netAmount, total: s.totalCost } });
      return { t, s };
    });
    if (prep.s.netAmount !== 0) {
      try {
        const pay = await this.payments.create(claims, {
          employeeId: prep.t.employee_id, paymentType: prep.s.netAmount > 0 ? "earning" : "deduction",
          label: prep.s.netAmount > 0 ? `Travel reimbursement: ${prep.t.destination}` : `Travel advance recovery: ${prep.t.destination}`,
          amount: Math.abs(prep.s.netAmount), isTaxable: false, effectiveDate: localToday(),
          reasonNote: `Trip ${iso(prep.t.start_date)} to ${iso(prep.t.end_date)}: cost ${prep.s.totalCost}, advance ${prep.s.advanceAmount}`,
        });
        await this.db.withClaims(claims, (c) => c.query("UPDATE travel_requests SET settlement_payment_id = $2 WHERE id = $1", [id, pay.id]));
      } catch (err) {
        // the payment could not be created: put the trip back so HR can settle again
        await this.db.withClaims(claims, (c) => c.query("UPDATE travel_requests SET status = 'approved', settled_at = NULL, total_cost = NULL, net_amount = NULL, updated_at = now() WHERE id = $1", [id]));
        throw err;
      }
    }
    const out = await this.db.withClaims(claims, async (client) => ({ v: await this.view(client, id), user: (await client.query("SELECT user_account_id FROM employees WHERE id = $1", [prep.t.employee_id])).rows[0]?.user_account_id as string | null }));
    await this.tell(prep.t.company_id, out.user, `Trip settled: ${prep.t.destination}`, prep.s.netAmount > 0 ? `PKR ${prep.s.netAmount} will be paid with your salary.` : prep.s.netAmount < 0 ? `PKR ${Math.abs(prep.s.netAmount)} of the advance will be recovered from your salary.` : "Nothing is owed either way.");
    return out.v;
  }

  // ------------------------------------------------------------------ internals

  private async loadForSettlement(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM travel_requests WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new NotFoundException("Travel request not found");
    const t = r.rows[0];
    if (t.status === "settled") throw new ConflictException("This trip is already settled");
    if (t.status !== "approved") throw new ConflictException("Only an approved trip can be settled");
    if (iso(t.start_date) > localToday()) throw new ConflictException("The trip has not started yet");
    return t;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async settlementFor(client: PoolClient, t: any, input: SettleTravelRequest): Promise<TravelSettlementView> {
    const days = Number(input.actualDays);
    const km = input.actualKm === null || input.actualKm === undefined ? 0 : Number(input.actualKm);
    const other = input.otherCost === null || input.otherCost === undefined ? 0 : Number(input.otherCost);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestException("Enter the number of days travelled (1 to 90)");
    if (!(km >= 0) || !(other >= 0)) throw new BadRequestException("Distance and other costs cannot be negative");
    const pd = await this.currentRate(client, "per_diem", t.trip_type);
    const mi = await this.currentRate(client, "mileage", t.trip_type);
    const c = computeSettlement({ days, km, otherCost: other, advance: Number(t.advance_amount), perDiemRate: pd, mileageRate: mi });
    return { actualDays: days, actualKm: km, otherCostNote: input.otherCostNote?.trim().slice(0, 500) || null, ...c };
  }

  private async employee(client: PoolClient, id: string) {
    const r = await client.query("SELECT id, company_id, user_account_id, first_name, last_name FROM employees WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Employee not found");
    return r.rows[0];
  }

  private async views(client: PoolClient, ids: string[]): Promise<TravelRequestView[]> {
    const out: TravelRequestView[] = [];
    for (const id of ids) out.push(await this.view(client, id));
    return out;
  }

  private async view(client: PoolClient, id: string): Promise<TravelRequestView> {
    const r = await client.query(
      `SELECT t.*, e.employee_number, e.first_name, e.last_name, e.user_account_id AS emp_user FROM travel_requests t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
      [id]
    );
    if (!r.rowCount) throw new NotFoundException("Travel request not found");
    const x = r.rows[0];
    const pd = await this.currentRate(client, "per_diem", x.trip_type);
    const mi = await this.currentRate(client, "mileage", x.trip_type);
    const estimated = money(tripDays(iso(x.start_date), iso(x.end_date)) * (pd ?? 0) + Number(x.est_distance_km ?? 0) * (mi ?? 0) + Number(x.est_other_cost ?? 0));
    const settled = x.status === "settled";
    return {
      id: x.id, employeeId: x.employee_id, employeeNumber: x.employee_number, employeeName: `${x.first_name} ${x.last_name}`, destination: x.destination, purpose: x.purpose,
      tripType: x.trip_type, travelMode: x.travel_mode, startDate: iso(x.start_date), endDate: iso(x.end_date), estDistanceKm: num(x.est_distance_km), estOtherCost: num(x.est_other_cost),
      advanceRequested: Number(x.advance_requested), estimatedCost: estimated, status: x.status as TravelStatus, isOnBehalf: x.emp_user !== null && x.submitted_by_user_account_id !== x.emp_user,
      decisionComment: x.decision_comment ?? null, decidedAt: isoTs(x.decided_at), advanceAmount: Number(x.advance_amount), advanceIssuedAt: isoTs(x.advance_issued_at), settledAt: isoTs(x.settled_at),
      settlement: settled
        ? {
            actualDays: x.actual_days, actualKm: Number(x.actual_km ?? 0), perDiemRate: num(x.per_diem_rate), mileageRate: num(x.mileage_rate), perDiemAmount: Number(x.per_diem_amount), mileageAmount: Number(x.mileage_amount),
            otherCost: Number(x.other_cost ?? 0), otherCostNote: x.other_cost_note ?? null, totalCost: Number(x.total_cost), advanceAmount: Number(x.advance_amount), netAmount: Number(x.net_amount), settlementPaymentCreated: x.settlement_payment_id !== null,
          }
        : null,
      createdAt: isoTs(x.created_at) as string,
    };
  }

  private async tell(companyId: string, userId: string | null, title: string, body: string): Promise<void> {
    if (!this.inbox || !userId) return;
    await this.inbox.notify({ companyId, userAccountIds: [userId], category: "assets_travel", title, body, link: "/app/travel" });
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, "expense"))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "travel.manage"))) throw new ForbiddenException("Not permitted to manage business travel");
  }
}
