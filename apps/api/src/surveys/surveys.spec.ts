import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MailerService } from "../mailer/mailer.service";
import { UserNotificationsService } from "../notifications/user-notifications.service";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { SurveysService } from "./surveys.service";

/** Pulse surveys against real Postgres: who can write, who can answer, and that nobody can be identified from the totals. */
describe("Pulse surveys", () => {
  let f: PayrollFixture;
  let svc: SurveysService;
  let unitA: string;
  type Person = { uid: string; claims: Awaited<ReturnType<PayrollFixture["makeUser"]>>; emp: { id: string } };
  const people: Person[] = [];
  let outsider: Person;
  const inbox = (uid: string) => f.sql<{ title: string }>("SELECT title FROM user_notifications WHERE user_account_id = $1", [uid]);

  beforeAll(async () => {
    f = await buildPayrollFixture("svy1");
    svc = new SurveysService(f.db, f.rbac, f.entitlements, f.audit, new UserNotificationsService(f.db, new MailerService()));
    unitA = (await f.sql<{ id: string }>("INSERT INTO org_units (company_id, unit_type, name) VALUES ($1,'department','Support') RETURNING id", [f.companyId]))[0].id;
    const mk = async (label: string, unit: string | null) => {
      const claims = await f.makeUser(label, ["employee_self_service"]);
      const emp = await f.createEmployee({ userAccountId: claims.uid, monthlySalary: null });
      if (unit) await f.sql("UPDATE employees SET org_unit_id = $2 WHERE id = $1", [emp.id, unit]);
      return { uid: claims.uid, claims, emp };
    };
    for (let i = 0; i < 6; i++) people.push(await mk(`p${i}`, unitA));
    outsider = await mk("out", null);
  }, 180000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  const questions = [
    { kind: "rating" as const, prompt: "My manager supports me" },
    { kind: "nps" as const, prompt: "How likely are you to recommend us as a place to work?" },
    { kind: "yes_no" as const, prompt: "I know what is expected of me" },
    { kind: "text" as const, prompt: "Anything else?", required: false },
  ];
  const answerFor = (qs: Array<{ id: string; kind: string }>, rating: number, nps: number, yes: boolean, text?: string) =>
    qs.map((q) => ({ questionId: q.id, ...(q.kind === "rating" ? { value: rating } : q.kind === "nps" ? { value: nps } : q.kind === "yes_no" ? { value: yes } : { text }) }));

  it("only HR can write a survey", async () => {
    await expect(svc.create(people[0].claims, { title: "x", questions })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.listAdmin(people[0].claims)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.results(people[0].claims, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("checks the form", async () => {
    await expect(svc.create(f.hr, { title: " ", questions })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create(f.hr, { title: "x", questions: [] })).rejects.toThrow(/at least one question/);
    await expect(svc.create(f.hr, { title: "x", questions: [{ kind: "rating", prompt: " " }] })).rejects.toThrow(/no text/);
    await expect(svc.create(f.hr, { title: "x", questions: [{ kind: "stars" as never, prompt: "p" }] })).rejects.toThrow(/unknown type/);
    await expect(svc.create(f.hr, { title: "x", questions, audienceType: "org_unit", audienceIds: [] })).rejects.toThrow(/at least one department/);
    await expect(svc.create(f.hr, { title: "x", questions, audienceType: "org_unit", audienceIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/does not exist/);
    await expect(svc.create(f.hr, { title: "x", questions: Array.from({ length: 31 }, () => ({ kind: "text" as const, prompt: "p" })) })).rejects.toThrow(/at most 30/);
  });

  let surveyId: string;
  let qs: Array<{ id: string; kind: string }>;

  it("a draft is invisible; opening it shows it to its audience only and rings the bell", async () => {
    const draft = await svc.create(f.hr, { title: "Team pulse", description: "Five minutes", audienceType: "org_unit", audienceIds: [unitA], questions });
    surveyId = draft.id;
    expect(draft).toMatchObject({ status: "draft", audienceCount: 6, responseCount: 0, audienceNames: ["Support"], minResponses: 5 });
    qs = draft.questions;
    expect(await svc.mine(people[0].claims)).toHaveLength(0);
    await expect(svc.results(f.hr, surveyId)).rejects.toBeInstanceOf(ConflictException);

    const opened = await svc.open(f.hr, surveyId);
    expect(opened.status).toBe("open");
    await expect(svc.open(f.hr, surveyId)).rejects.toBeInstanceOf(ConflictException);
    expect(await svc.mine(people[0].claims)).toMatchObject([{ id: surveyId, title: "Team pulse", questions: [{ position: 1 }, { position: 2 }, { position: 3 }, { position: 4 }] }]);
    expect(await svc.mine(outsider.claims)).toHaveLength(0);
    expect(await svc.count(people[0].claims)).toEqual({ waiting: 1 });
    expect((await inbox(people[0].uid)).some((n) => n.title === "Survey: Team pulse")).toBe(true);
    expect(await inbox(outsider.uid)).toHaveLength(0);
    await expect(svc.respond(outsider.claims, surveyId, { answers: answerFor(qs, 4, 8, true) })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an open survey cannot be edited or deleted", async () => {
    await expect(svc.update(f.hr, surveyId, { title: "Changed", questions })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remove(f.hr, surveyId)).rejects.toBeInstanceOf(ConflictException);
  });

  it("checks the answers", async () => {
    await expect(svc.respond(people[0].claims, surveyId, { answers: answerFor(qs, 9, 8, true) })).rejects.toThrow(/whole number from 1 to 5/);
    await expect(svc.respond(people[0].claims, surveyId, { answers: answerFor(qs, 4, 11, true) })).rejects.toThrow(/whole number from 0 to 10/);
    await expect(svc.respond(people[0].claims, surveyId, { answers: answerFor(qs, 4, 8, true).slice(0, 1) })).rejects.toThrow(/Please answer/);
    await expect(svc.respond(people[0].claims, surveyId, { answers: [{ questionId: "00000000-0000-4000-8000-000000000000", value: 3 }] })).rejects.toThrow(/not in this survey/);
    // nothing was kept by any refused attempt
    expect((await f.sql<{ n: number }>("SELECT COUNT(*)::int AS n FROM survey_participation WHERE survey_id = $1", [surveyId]))[0].n).toBe(0);
    expect((await f.sql<{ n: number }>("SELECT COUNT(*)::int AS n FROM survey_answers WHERE survey_id = $1", [surveyId]))[0].n).toBe(0);
  });

  it("results stay hidden until five people have answered, and nobody answers twice", async () => {
    // [rating, nps, yes, text]
    const input: Array<[number, number, boolean, string | undefined]> = [
      [5, 10, true, "Great team"],
      [4, 9, true, undefined],
      [3, 8, true, "Too many meetings"],
      [2, 3, false, undefined],
    ];
    for (let i = 0; i < 4; i++) await svc.respond(people[i].claims, surveyId, { answers: answerFor(qs, ...input[i]) });
    await expect(svc.respond(people[0].claims, surveyId, { answers: answerFor(qs, 4, 8, true) })).rejects.toThrow(/already answered/);
    expect(await svc.mine(people[0].claims)).toHaveLength(0);

    const early = await svc.results(f.hr, surveyId);
    expect(early).toMatchObject({ visible: false, responseCount: 4, audienceCount: 6, minResponses: 5, questions: [] });
    expect(early.message).toMatch(/4 of the 5 answers needed/);
    expect((await svc.getAdmin(f.hr, surveyId)).responseCount).toBe(4);

    await svc.respond(people[4].claims, surveyId, { answers: answerFor(qs, 5, 10, true, "Keep it up") });
    const shown = await svc.results(f.hr, surveyId);
    expect(shown).toMatchObject({ visible: true, responseCount: 5, message: null });
    const [rating, nps, yesNo, text] = shown.questions;
    expect(rating).toMatchObject({ answered: 5, average: 3.8, distribution: [0, 1, 1, 1, 2] });
    // nps answers 10, 9, 8, 3, 10: promoters 3, passives 1, detractors 1 => (3 - 1) / 5 = 40
    expect(nps).toMatchObject({ answered: 5, promoters: 3, passives: 1, detractors: 1, enps: 40 });
    expect(nps.distribution).toHaveLength(11);
    expect(yesNo).toMatchObject({ yes: 4, no: 1 });
    // only 3 people wrote a comment: fewer than five, so the comments stay hidden
    expect(text).toMatchObject({ answered: 3 });
    expect(text.texts).toBeUndefined();
  });

  it("written comments stay hidden under five, then appear for everyone in a shuffled order", async () => {
    await svc.respond(people[5].claims, surveyId, { answers: answerFor(qs, 4, 7, true, "More training please") });
    // four people wrote a comment: still fewer than five
    expect((await svc.results(f.hr, surveyId)).questions[3]).toMatchObject({ answered: 4 });
    expect((await svc.results(f.hr, surveyId)).questions[3].texts).toBeUndefined();

    const s2 = await svc.create(f.hr, { title: "Comments only", audienceType: "org_unit", audienceIds: [unitA], questions: [{ kind: "text", prompt: "What would you change?" }], open: true });
    const q2 = s2.questions;
    const said = ["one", "two", "three", "four", "five"];
    for (let i = 0; i < 5; i++) await svc.respond(people[i].claims, s2.id, { answers: [{ questionId: q2[0].id, text: said[i] }] });
    const texts = (await svc.results(f.hr, s2.id)).questions[0].texts!;
    expect([...texts].sort()).toEqual([...said].sort());
    // the order is random: across many reads it is not always the order people answered in
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) orders.add((await svc.results(f.hr, s2.id)).questions[0].texts!.join(","));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("the stored answers cannot be tied back to a person", async () => {
    const cols = async (t: string) => (await f.sql<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).map((c) => c.column_name);
    const answerCols = await cols("survey_answers");
    expect(answerCols).not.toEqual(expect.arrayContaining(["employee_id"]));
    expect(answerCols.filter((c) => /time|_at|_on|date|user|employee/.test(c))).toEqual([]);
    expect(await cols("survey_participation")).not.toEqual(expect.arrayContaining(["value_int"]));
    expect((await cols("survey_participation")).filter((c) => /value|answer|question/.test(c))).toEqual([]);
    expect((await f.sql<{ n: number }>("SELECT COUNT(*)::int AS n FROM survey_participation WHERE survey_id = $1", [surveyId]))[0].n).toBe(6);
  });

  it("closing stops answers and keeps the totals; a draft can be deleted", async () => {
    const closed = await svc.close(f.hr, surveyId);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();
    await expect(svc.close(f.hr, surveyId)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.open(f.hr, surveyId)).rejects.toBeInstanceOf(ConflictException);
    expect((await svc.results(f.hr, surveyId)).visible).toBe(true);

    const draft = await svc.create(f.hr, { title: "Scrap", questions: [{ kind: "text", prompt: "p" }] });
    await svc.remove(f.hr, draft.id);
    await expect(svc.getAdmin(f.hr, draft.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.open(f.hr, (await svc.create(f.hr, { title: "Late", closesOn: "2020-01-01", questions: [{ kind: "text", prompt: "p" }] })).id)).rejects.toThrow(/closing date has already passed/);
  });
});
