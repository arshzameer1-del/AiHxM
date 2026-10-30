import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type {
  MySurveyView,
  SaveSurveyRequest,
  SubmitSurveyRequest,
  SurveyAdminView,
  SurveyQuestionKind,
  SurveyQuestionResult,
  SurveyQuestionView,
  SurveyResultsView,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { RbacService } from "../rbac/rbac.service";

const MODULE_KEY = "employee" as const;
const MANAGE = "survey.manage";
const KINDS: SurveyQuestionKind[] = ["rating", "nps", "yes_no", "text"];
const MAX_QUESTIONS = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string | null => (v?.toISOString ? v.toISOString() : v ?? null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string | null => (v ? (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

/**
 * Pulse surveys. HR writes a short set of questions and opens the survey; people in the audience answer once;
 * HR reads the totals. Nobody, HR included, can see who gave which answer: answers are stored without an employee
 * and without a time, and totals stay hidden until at least `min_responses` (never fewer than 5) people have answered.
 */
@Injectable()
export class SurveysService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly inbox: UserNotificationsService
  ) {}

  // ------------------------------------------------------------------ HR

  async listAdmin(claims: RequestClaims): Promise<SurveyAdminView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM surveys WHERE company_id = $1 ORDER BY (status = 'draft') DESC, (status = 'open') DESC, created_at DESC LIMIT 200", [claims.company_id]);
      const out: SurveyAdminView[] = [];
      for (const row of r.rows) out.push(await this.toAdmin(client, row));
      return out;
    });
  }

  async getAdmin(claims: RequestClaims, id: string): Promise<SurveyAdminView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => this.toAdmin(client, await this.load(client, id)));
  }

  async create(claims: RequestClaims, input: SaveSurveyRequest): Promise<SurveyAdminView> {
    await this.requireManage(claims);
    const v = this.validate(input);
    const id = await this.db.withClaims(claims, async (client) => {
      await this.assertAudience(client, v.audienceType, v.audienceIds);
      const r = await client.query(
        `INSERT INTO surveys (company_id, title, description, audience_type, audience_ids, closes_on, created_by)
         VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7) RETURNING id`,
        [claims.company_id, v.title, v.description, v.audienceType, v.audienceIds, v.closesOn, claims.sub]
      );
      await this.writeQuestions(client, claims.company_id!, r.rows[0].id, v.questions);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "survey.create", target: r.rows[0].id, metadata: { title: v.title, questions: v.questions.length } });
      return r.rows[0].id as string;
    });
    return input.open ? this.open(claims, id) : this.getAdmin(claims, id);
  }

  async update(claims: RequestClaims, id: string, input: SaveSurveyRequest): Promise<SurveyAdminView> {
    await this.requireManage(claims);
    const v = this.validate(input);
    await this.db.withClaims(claims, async (client) => {
      const row = (await client.query("SELECT * FROM surveys WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new NotFoundException("Survey not found");
      if (row.status !== "draft") throw new ConflictException("Only a draft survey can be changed. Questions cannot change once people can answer.");
      await this.assertAudience(client, v.audienceType, v.audienceIds);
      await client.query("UPDATE surveys SET title=$2, description=$3, audience_type=$4, audience_ids=$5::uuid[], closes_on=$6, updated_at=now() WHERE id=$1", [id, v.title, v.description, v.audienceType, v.audienceIds, v.closesOn]);
      await client.query("DELETE FROM survey_questions WHERE survey_id = $1", [id]);
      await this.writeQuestions(client, claims.company_id!, id, v.questions);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "survey.update", target: id, metadata: { questions: v.questions.length } });
    });
    return input.open ? this.open(claims, id) : this.getAdmin(claims, id);
  }

  async open(claims: RequestClaims, id: string): Promise<SurveyAdminView> {
    await this.requireManage(claims);
    const today = localToday();
    const { row, people } = await this.db.withClaims(claims, async (client) => {
      const locked = (await client.query("SELECT * FROM surveys WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!locked) throw new NotFoundException("Survey not found");
      if (locked.status !== "draft") throw new ConflictException(locked.status === "open" ? "This survey is already open" : "A closed survey cannot be opened again");
      if (locked.closes_on && day(locked.closes_on)! < today) throw new BadRequestException("The closing date has already passed");
      const count = (await client.query("SELECT COUNT(*)::int AS n FROM survey_questions WHERE survey_id = $1", [id])).rows[0].n;
      if (count === 0) throw new BadRequestException("Add at least one question before opening the survey");
      await client.query("UPDATE surveys SET status = 'open', opened_at = now(), updated_at = now() WHERE id = $1", [id]);
      const people = await this.audienceRows(client, locked);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "survey.open", target: id, metadata: { audience: people.length } });
      return { row: locked, people };
    });
    await this.inbox.notify({
      companyId: claims.company_id!,
      userAccountIds: people.map((p) => p.user_account_id),
      category: "announcements",
      title: `Survey: ${row.title}`,
      body: "HR would like your answers. It is anonymous and takes a few minutes.",
      link: "/app/ess/surveys",
    });
    return this.getAdmin(claims, id);
  }

  async close(claims: RequestClaims, id: string): Promise<SurveyAdminView> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const locked = (await client.query("SELECT * FROM surveys WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!locked) throw new NotFoundException("Survey not found");
      if (locked.status !== "open") throw new ConflictException(locked.status === "draft" ? "A draft survey is not open yet" : "This survey is already closed");
      await client.query("UPDATE surveys SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "survey.close", target: id, metadata: {} });
    });
    return this.getAdmin(claims, id);
  }

  async remove(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    await this.db.withClaims(claims, async (client) => {
      const locked = (await client.query("SELECT * FROM surveys WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!locked) throw new NotFoundException("Survey not found");
      if (locked.status !== "draft") throw new ConflictException("Only a draft survey can be deleted. Close an open survey instead.");
      await client.query("DELETE FROM surveys WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "survey.delete", target: id, metadata: { title: locked.title } });
    });
  }

  /** Totals for HR. Hidden entirely until enough people have answered; a question few people answered stays hidden too. */
  async results(claims: RequestClaims, id: string): Promise<SurveyResultsView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.load(client, id);
      if (row.status === "draft") throw new ConflictException("A draft survey has no answers yet");
      const min = row.min_responses as number;
      const audienceCount = (await this.audienceRows(client, row)).length;
      const responseCount = (await client.query("SELECT COUNT(*)::int AS n FROM survey_participation WHERE survey_id = $1", [id])).rows[0].n as number;
      const base = { surveyId: id, status: row.status, audienceCount, responseCount, minResponses: min };
      if (responseCount < min) {
        return {
          ...base,
          visible: false,
          message: `${responseCount} of the ${min} answers needed so far. Results stay hidden until ${min} people have answered, so that nobody can be identified.`,
          questions: [],
        };
      }
      const questions = (await client.query("SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY position", [id])).rows;
      const out: SurveyQuestionResult[] = [];
      for (const q of questions) out.push(await this.questionResult(client, q, min));
      return { ...base, visible: true, message: null, questions: out };
    });
  }

  // ------------------------------------------------------------------ employees

  /** Open surveys I can still answer. */
  async mine(claims: RequestClaims): Promise<MySurveyView[]> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      const r = await client.query(
        `SELECT s.* FROM surveys s
           JOIN employees e ON e.id = $1 AND e.company_id = s.company_id
          WHERE s.status = 'open' AND (s.closes_on IS NULL OR s.closes_on >= $2::date)
            AND (s.audience_type = 'all' OR (s.audience_type = 'org_unit' AND e.org_unit_id = ANY(s.audience_ids)) OR (s.audience_type = 'location' AND e.location_id = ANY(s.audience_ids)))
            AND NOT EXISTS (SELECT 1 FROM survey_participation p WHERE p.survey_id = s.id AND p.employee_id = e.id)
          ORDER BY s.opened_at DESC LIMIT 50`,
        [emp.id, localToday()]
      );
      const out: MySurveyView[] = [];
      for (const s of r.rows) {
        out.push({ id: s.id, title: s.title, description: s.description, closesOn: day(s.closes_on), questions: await this.questions(client, s.id) });
      }
      return out;
    });
  }

  async count(claims: RequestClaims): Promise<{ waiting: number }> {
    return { waiting: (await this.mine(claims)).length };
  }

  async respond(claims: RequestClaims, id: string, input: SubmitSurveyRequest): Promise<{ ok: true }> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, async (client) => {
      const emp = await this.myEmployee(client, claims);
      const survey = (
        await client.query(
          `SELECT s.* FROM surveys s JOIN employees e ON e.id = $2 AND e.company_id = s.company_id
            WHERE s.id = $1 AND s.status = 'open' AND (s.closes_on IS NULL OR s.closes_on >= $3::date) AND e.employment_status = 'active'
              AND (s.audience_type = 'all' OR (s.audience_type = 'org_unit' AND e.org_unit_id = ANY(s.audience_ids)) OR (s.audience_type = 'location' AND e.location_id = ANY(s.audience_ids)))`,
          [id, emp.id, localToday()]
        )
      ).rows[0];
      if (!survey) throw new NotFoundException("This survey is not open for you");
      const questions = (await client.query("SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY position", [id])).rows;
      const rows = this.checkAnswers(questions, input);

      // one answer per person: the participation row is the lock, and holds no answers
      const mark = await client.query("INSERT INTO survey_participation (survey_id, employee_id, company_id, submitted_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, emp.id, claims.company_id, localToday()]);
      if (!mark.rowCount) throw new ConflictException("You have already answered this survey");
      for (const a of rows) {
        await client.query("INSERT INTO survey_answers (survey_id, question_id, company_id, value_int, value_text) VALUES ($1,$2,$3,$4,$5)", [id, a.questionId, claims.company_id, a.int, a.text]);
      }
      return { ok: true as const };
    });
  }

  // ------------------------------------------------------------------ helpers

  private checkAnswers(questions: Array<{ id: string; kind: SurveyQuestionKind; prompt: string; required: boolean }>, input: SubmitSurveyRequest) {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const seen = new Set<string>();
    const rows: Array<{ questionId: string; int: number | null; text: string | null }> = [];
    for (const a of input.answers ?? []) {
      const q = byId.get(a.questionId);
      if (!q) throw new BadRequestException("One of the answers is for a question that is not in this survey");
      if (seen.has(q.id)) throw new BadRequestException("A question was answered twice");
      seen.add(q.id);
      if (q.kind === "text") {
        const text = typeof a.text === "string" ? a.text.trim() : "";
        if (!text) continue;
        if (text.length > 2000) throw new BadRequestException("A written answer can be at most 2,000 characters");
        rows.push({ questionId: q.id, int: null, text });
      } else if (q.kind === "yes_no") {
        if (typeof a.value !== "boolean") throw new BadRequestException(`Answer yes or no: ${q.prompt}`);
        rows.push({ questionId: q.id, int: a.value ? 1 : 0, text: null });
      } else {
        const [lo, hi] = q.kind === "rating" ? [1, 5] : [0, 10];
        if (typeof a.value !== "number" || !Number.isInteger(a.value) || a.value < lo || a.value > hi) throw new BadRequestException(`Choose a whole number from ${lo} to ${hi}: ${q.prompt}`);
        rows.push({ questionId: q.id, int: a.value, text: null });
      }
    }
    for (const q of questions) {
      if (q.required && !rows.some((r) => r.questionId === q.id)) throw new BadRequestException(`Please answer: ${q.prompt}`);
    }
    if (rows.length === 0) throw new BadRequestException("Answer at least one question");
    return rows;
  }

  private async questionResult(client: PoolClient, q: { id: string; position: number; kind: SurveyQuestionKind; prompt: string }, min: number): Promise<SurveyQuestionResult> {
    const base: SurveyQuestionResult = { questionId: q.id, position: q.position, kind: q.kind, prompt: q.prompt, answered: 0 };
    const answered = (await client.query("SELECT COUNT(*)::int AS n FROM survey_answers WHERE question_id = $1", [q.id])).rows[0].n as number;
    base.answered = answered;
    // a question few people answered would point at them: say how many, show nothing else
    if (answered < min) return base;
    if (q.kind === "text") {
      const t = await client.query("SELECT value_text FROM survey_answers WHERE question_id = $1 ORDER BY random()", [q.id]);
      return { ...base, texts: t.rows.map((x) => x.value_text as string) };
    }
    const vals = (await client.query("SELECT value_int AS v, COUNT(*)::int AS n FROM survey_answers WHERE question_id = $1 GROUP BY value_int", [q.id])).rows;
    const count = (v: number) => vals.find((x) => x.v === v)?.n ?? 0;
    if (q.kind === "yes_no") return { ...base, yes: count(1), no: count(0) };
    const lo = q.kind === "rating" ? 1 : 0;
    const hi = q.kind === "rating" ? 5 : 10;
    const distribution = Array.from({ length: hi - lo + 1 }, (_, i) => count(lo + i));
    const total = distribution.reduce((s, n) => s + n, 0);
    const sum = distribution.reduce((s, n, i) => s + n * (lo + i), 0);
    const out: SurveyQuestionResult = { ...base, distribution, average: Math.round((sum / total) * 100) / 100 };
    if (q.kind === "nps") {
      const promoters = count(9) + count(10);
      const detractors = distribution.slice(0, 7).reduce((s, n) => s + n, 0);
      Object.assign(out, { promoters, passives: total - promoters - detractors, detractors, enps: Math.round(((promoters - detractors) / total) * 100) });
    }
    return out;
  }

  private validate(input: SaveSurveyRequest) {
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("Give the survey a title");
    if (title.length > 200) throw new BadRequestException("The title can be at most 200 characters");
    const description = input.description?.trim() ? input.description.trim() : null;
    if (description && description.length > 2000) throw new BadRequestException("The description can be at most 2,000 characters");
    const audienceType = input.audienceType ?? "all";
    const audienceIds = audienceType === "all" ? [] : [...new Set(input.audienceIds ?? [])];
    if (audienceType !== "all" && audienceIds.length === 0) throw new BadRequestException(`Choose at least one ${audienceType === "org_unit" ? "department" : "location"}`);
    const closesOn = input.closesOn ? String(input.closesOn).slice(0, 10) : null;
    if (closesOn && !/^\d{4}-\d{2}-\d{2}$/.test(closesOn)) throw new BadRequestException("The closing date is not a valid date");
    const questions = input.questions ?? [];
    if (questions.length === 0) throw new BadRequestException("Add at least one question");
    if (questions.length > MAX_QUESTIONS) throw new BadRequestException(`A survey can have at most ${MAX_QUESTIONS} questions`);
    const clean = questions.map((q, i) => {
      const prompt = (q.prompt ?? "").trim();
      if (!prompt) throw new BadRequestException(`Question ${i + 1} has no text`);
      if (prompt.length > 500) throw new BadRequestException(`Question ${i + 1} is longer than 500 characters`);
      if (!KINDS.includes(q.kind)) throw new BadRequestException(`Question ${i + 1} has an unknown type`);
      return { kind: q.kind, prompt, required: q.required ?? true };
    });
    return { title, description, audienceType, audienceIds, closesOn, questions: clean };
  }

  private async writeQuestions(client: PoolClient, companyId: string, surveyId: string, qs: Array<{ kind: SurveyQuestionKind; prompt: string; required: boolean }>) {
    for (let i = 0; i < qs.length; i++) {
      await client.query("INSERT INTO survey_questions (survey_id, company_id, position, kind, prompt, required) VALUES ($1,$2,$3,$4,$5,$6)", [surveyId, companyId, i + 1, qs[i].kind, qs[i].prompt, qs[i].required]);
    }
  }

  private async questions(client: PoolClient, surveyId: string): Promise<SurveyQuestionView[]> {
    const r = await client.query("SELECT id, position, kind, prompt, required FROM survey_questions WHERE survey_id = $1 ORDER BY position", [surveyId]);
    return r.rows.map((q) => ({ id: q.id, position: q.position, kind: q.kind, prompt: q.prompt, required: q.required }));
  }

  private async load(client: PoolClient, id: string) {
    const r = await client.query("SELECT * FROM surveys WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Survey not found");
    return r.rows[0];
  }

  private async audienceRows(client: PoolClient, s: { company_id: string; audience_type: string; audience_ids: string[] }) {
    const r = await client.query(
      `SELECT e.id, e.user_account_id FROM employees e
        WHERE e.company_id = $1 AND e.employment_status = 'active'
          AND ($2 = 'all' OR ($2 = 'org_unit' AND e.org_unit_id = ANY($3::uuid[])) OR ($2 = 'location' AND e.location_id = ANY($3::uuid[])))`,
      [s.company_id, s.audience_type, s.audience_ids]
    );
    return r.rows as Array<{ id: string; user_account_id: string | null }>;
  }

  private async assertAudience(client: PoolClient, type: string, ids: string[]) {
    if (type === "all") return;
    const table = type === "org_unit" ? "org_units" : "locations";
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    if (r.rows[0].n !== ids.length) throw new BadRequestException(`One of the chosen ${type === "org_unit" ? "departments" : "locations"} does not exist`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async toAdmin(client: PoolClient, row: any): Promise<SurveyAdminView> {
    const names =
      row.audience_type === "org_unit"
        ? (await client.query("SELECT COALESCE(array_agg(name ORDER BY name), '{}') AS n FROM org_units WHERE id = ANY($1::uuid[])", [row.audience_ids])).rows[0].n
        : row.audience_type === "location"
          ? (await client.query("SELECT COALESCE(array_agg(name ORDER BY name), '{}') AS n FROM locations WHERE id = ANY($1::uuid[])", [row.audience_ids])).rows[0].n
          : [];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      audienceType: row.audience_type,
      audienceIds: row.audience_ids,
      audienceNames: names,
      audienceCount: (await this.audienceRows(client, row)).length,
      responseCount: (await client.query("SELECT COUNT(*)::int AS n FROM survey_participation WHERE survey_id = $1", [row.id])).rows[0].n,
      closesOn: day(row.closes_on),
      minResponses: row.min_responses,
      openedAt: iso(row.opened_at),
      closedAt: iso(row.closed_at),
      questions: await this.questions(client, row.id),
    };
  }

  private async myEmployee(client: PoolClient, claims: RequestClaims) {
    const r = await client.query("SELECT id, company_id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub]);
    if (!r.rowCount) throw new ForbiddenException("Your login is not linked to an employee record");
    return r.rows[0] as { id: string; company_id: string };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, MANAGE))) throw new ForbiddenException("Not permitted to manage surveys");
  }
}
