import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { buildPayrollFixture, type PayrollFixture } from "../payroll/testing/payroll-fixture";
import { CourseEnrollmentsService } from "./course-enrollments.service";
import { CourseExamsService, scoreExam } from "./course-exams.service";
import { LearningPathsService } from "./learning-paths.service";

describe("scoreExam", () => {
  it("counts right answers, treats a skipped question as wrong and rounds to two places", () => {
    expect(scoreExam([0, 1, 2], [0, 1, 2])).toEqual({ correctCount: 3, scorePct: 100 });
    expect(scoreExam([0, 1, 2], [0, null, 0])).toEqual({ correctCount: 1, scorePct: 33.33 });
    expect(scoreExam([], [])).toEqual({ correctCount: 0, scorePct: 0 });
  });
});

/** Learning paths, exams and certificates against real Postgres. */
describe("Learning paths, course exams and certificates", () => {
  let f: PayrollFixture;
  let paths: LearningPathsService;
  let exams: CourseExamsService;
  let enrollments: CourseEnrollmentsService;
  let ann: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let annEmp: string;
  let bob: Awaited<ReturnType<PayrollFixture["makeUser"]>>;
  let bobEmp: string;
  const courseIds: string[] = [];
  let n = 0;

  const mkCourse = async (title: string, minutes = 30) =>
    (await f.sql<{ id: string }>("INSERT INTO courses (company_id, title, category, duration_minutes) VALUES ($1,$2,'technical',$3) RETURNING id", [f.companyId, `${title} ${++n}`, minutes]))[0].id;
  const exam = (over: Record<string, unknown> = {}) => ({
    title: "Safety check", passMarkPct: 60, maxAttempts: 2,
    questions: [
      { prompt: "Which colour is a fire exit sign?", options: ["Green", "Red", "Blue"], correctIndex: 0 },
      { prompt: "Who do you tell first about a hazard?", options: ["Nobody", "Your supervisor", "A customer"], correctIndex: 1 },
      { prompt: "Wet floor means?", options: ["Run", "Slow down", "Ignore"], correctIndex: 1 },
    ],
    ...over,
  });
  const enrollmentOf = async (empId: string, courseId: string) => (await f.sql<{ id: string }>("SELECT id FROM course_enrollments WHERE employee_id = $1 AND course_id = $2", [empId, courseId]))[0]?.id;

  beforeAll(async () => {
    f = await buildPayrollFixture("lrn1");
    await f.sql("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'learning',true) ON CONFLICT DO NOTHING", [f.companyId]);
    paths = new LearningPathsService(f.db, f.rbac, f.entitlements, f.audit);
    exams = new CourseExamsService(f.db, f.rbac, f.entitlements, f.audit);
    enrollments = new CourseEnrollmentsService(f.db, f.rbac, f.entitlements, f.audit);
    ann = await f.makeUser("lrn-ann", ["employee_self_service"]);
    annEmp = (await f.createEmployee({ userAccountId: ann.uid, monthlySalary: null })).id;
    bob = await f.makeUser("lrn-bob", ["employee_self_service"]);
    bobEmp = (await f.createEmployee({ userAccountId: bob.uid, monthlySalary: null })).id;
    for (const t of ["Induction", "Safety", "Data handling"]) courseIds.push(await mkCourse(t));
  }, 120000);

  afterAll(async () => {
    await f.cleanup();
  }, 60000);

  it("only HR builds paths; staff cannot, and a path needs real, distinct courses", async () => {
    await expect(paths.create(ann, { title: "x", courseIds: [courseIds[0]] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(paths.create(f.hr, { title: " ", courseIds: [courseIds[0]] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(paths.create(f.hr, { title: "Empty", courseIds: [] })).rejects.toThrow(/between 1 and 30/);
    await expect(paths.create(f.hr, { title: "Dup", courseIds: [courseIds[0], courseIds[0]] })).rejects.toThrow(/only once/);
    await expect(paths.create(f.hr, { title: "Ghost", courseIds: ["00000000-0000-0000-0000-000000000000"] })).rejects.toThrow(/not found/);
    const p = await paths.create(f.hr, { title: "New starter", courseIds });
    expect(p.courses.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(p.totalMinutes).toBe(90);
    await expect(paths.create(f.hr, { title: "new STARTER", courseIds: [courseIds[0]] })).rejects.toBeInstanceOf(ConflictException);
    const reordered = await paths.update(f.hr, p.id, { title: "New starter", courseIds: [courseIds[2], courseIds[0], courseIds[1]] });
    expect(reordered.courses.map((c) => c.courseId)).toEqual([courseIds[2], courseIds[0], courseIds[1]]);
    await paths.update(f.hr, p.id, { title: "New starter", courseIds });
  });

  it("assigning a path enrols people in its courses once, and keeps existing progress", async () => {
    const p = (await paths.list(f.hr))[0];
    await enrollments.enroll(f.hr, { employeeId: annEmp, courseId: courseIds[0] });
    await f.sql("UPDATE course_enrollments SET progress_percent = 40, status = 'in_progress' WHERE employee_id = $1", [annEmp]);
    await expect(paths.assign(ann, p.id, { employeeIds: [annEmp] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(paths.assign(f.hr, p.id, { employeeIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(paths.assign(f.hr, p.id, { employeeIds: ["00000000-0000-0000-0000-000000000000"] })).rejects.toBeInstanceOf(BadRequestException);
    expect(await paths.assign(f.hr, p.id, { employeeIds: [annEmp, bobEmp], dueDate: "2027-01-31" })).toEqual({ assigned: 2, alreadyAssigned: 0, enrollmentsCreated: 5 });
    expect(await paths.assign(f.hr, p.id, { employeeIds: [annEmp] })).toEqual({ assigned: 0, alreadyAssigned: 1, enrollmentsCreated: 0 });
    expect((await f.sql<{ progress_percent: number }>("SELECT progress_percent FROM course_enrollments WHERE employee_id = $1 AND course_id = $2", [annEmp, courseIds[0]]))[0].progress_percent).toBe(40);
  });

  it("the employee sees their path with progress, and HR sees everyone's", async () => {
    const mine = await paths.mine(ann);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "New starter", totalCourses: 3, completedCourses: 0, dueDate: "2027-01-31" });
    expect(mine[0].courses.map((c) => c.status)).toEqual(["in_progress", "assigned", "assigned"]);
    await enrollments.updateProgress(ann, (await enrollmentOf(annEmp, courseIds[1]))!, 100);
    expect((await paths.mine(ann))[0].completedCourses).toBe(1);
    expect(await paths.mine(bob).then((m) => m[0].completedCourses)).toBe(0);
    const prog = await paths.progress(f.hr, (await paths.list(f.hr))[0].id);
    expect(prog.map((r) => `${r.completedCourses}/${r.totalCourses}`).sort()).toEqual(["0/3", "1/3"]);
    await expect(paths.progress(ann, (await paths.list(f.hr))[0].id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an exam needs a sensible set of questions, and only HR sees the answer key", async () => {
    const c = courseIds[2];
    await expect(exams.save(ann, c, exam())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(exams.save(f.hr, c, exam({ passMarkPct: 0 }))).rejects.toThrow(/pass mark/);
    await expect(exams.save(f.hr, c, exam({ questions: [] }))).rejects.toThrow(/between 1 and 50/);
    await expect(exams.save(f.hr, c, exam({ questions: [{ prompt: "Q", options: ["a"], correctIndex: 0 }] }))).rejects.toThrow(/2 and 6 choices/);
    await expect(exams.save(f.hr, c, exam({ questions: [{ prompt: "Q", options: ["a", "A"], correctIndex: 0 }] }))).rejects.toThrow(/identical/);
    await expect(exams.save(f.hr, c, exam({ questions: [{ prompt: "Q", options: ["a", "b"], correctIndex: 5 }] }))).rejects.toThrow(/mark which/);
    const saved = await exams.save(f.hr, c, exam());
    expect(saved.questions[0].correctIndex).toBe(0);
    expect(await exams.getForCourse(f.hr, c)).toMatchObject({ passMarkPct: 60, attemptCount: 0 });
    await expect(exams.getForCourse(ann, c)).rejects.toBeInstanceOf(ForbiddenException);
    const taker = await exams.forTaker(ann, (await enrollmentOf(annEmp, c))!);
    expect(JSON.stringify(taker)).not.toMatch(/correct/i);
    expect(taker).toMatchObject({ passMarkPct: 60, attemptsLeft: 2, passed: false });
  });

  it("a course with an exam cannot be completed with the progress bar, and others still can", async () => {
    const enr = (await enrollmentOf(annEmp, courseIds[2]))!;
    await expect(enrollments.updateProgress(ann, enr, 100)).rejects.toThrow(/Pass the exam/);
    expect((await enrollments.updateProgress(ann, enr, 50)).progressPercent).toBe(50);
  });

  it("failing uses an attempt, passing completes the course, and the result never says which answers were right", async () => {
    const enr = (await enrollmentOf(annEmp, courseIds[2]))!;
    await expect(exams.submit(ann, enr, [0, 1])).rejects.toThrow(/Answer every question/);
    await expect(exams.submit(ann, enr, [0, 1, 9])).rejects.toThrow(/not a valid choice/);
    await expect(exams.submit(bob, enr, [0, 1, 1])).rejects.toBeInstanceOf(ForbiddenException);
    const fail = await exams.submit(ann, enr, [1, 0, 0]);
    expect(fail).toMatchObject({ scorePct: 0, passed: false, attemptsLeft: 1, enrollmentCompleted: false });
    expect(Object.keys(fail)).not.toContain("answers");
    const pass = await exams.submit(ann, enr, [0, 1, 0]);
    expect(pass).toMatchObject({ scorePct: 66.67, passed: true, enrollmentCompleted: true });
    expect((await f.sql<{ status: string; progress_percent: number }>("SELECT status, progress_percent FROM course_enrollments WHERE id = $1", [enr]))[0]).toEqual({ status: "completed", progress_percent: 100 });
    await expect(exams.submit(ann, enr, [0, 1, 1])).rejects.toThrow(/already completed/);
  });

  it("attempts run out, and HR can give them back", async () => {
    const enr = (await enrollmentOf(bobEmp, courseIds[2]))!;
    await exams.submit(bob, enr, [1, 0, 0]);
    await exams.submit(bob, enr, [1, 0, 0]);
    await expect(exams.submit(bob, enr, [0, 1, 1])).rejects.toThrow(/used all your attempts/);
    await expect(exams.resetAttempts(bob, enr)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await exams.resetAttempts(f.hr, enr)).toEqual({ cleared: 2 });
    expect((await exams.submit(bob, enr, [0, 1, 1])).passed).toBe(true);
  });

  it("a certificate is issued only for a completed course, to its owner or HR", async () => {
    const annDone = (await enrollmentOf(annEmp, courseIds[2]))!;
    const cert = await exams.certificate(ann, annDone);
    expect(cert).toMatchObject({ courseTitle: expect.stringContaining("Data handling"), scorePct: 66.67 });
    expect(cert.certificateNo).toMatch(/^CERT-\d{4}-[0-9A-F]{8}$/);
    expect((await exams.certificate(f.hr, annDone)).certificateNo).toBe(cert.certificateNo);
    await expect(exams.certificate(bob, annDone)).rejects.toBeInstanceOf(ForbiddenException);
    const notDone = (await enrollmentOf(bobEmp, courseIds[0]))!;
    await expect(exams.certificate(bob, notDone)).rejects.toBeInstanceOf(ConflictException);
    await expect(exams.certificate(bob, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("removing the exam lets the course complete the ordinary way", async () => {
    const c = await mkCourse("Plain");
    await exams.save(f.hr, c, exam());
    await exams.remove(f.hr, c);
    await expect(exams.remove(f.hr, c)).rejects.toBeInstanceOf(NotFoundException);
    await enrollments.enroll(f.hr, { employeeId: annEmp, courseId: c });
    expect((await enrollments.updateProgress(ann, (await enrollmentOf(annEmp, c))!, 100)).status).toBe("completed");
  });
});
