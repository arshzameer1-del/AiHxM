import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AssistantAnswer } from "@aihxm/shared-types";
import { localToday } from "../common/local-date";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";

const has = (q: string, words: string[]) => words.some((w) => q.includes(w));

/** Which of the few supported questions a sentence is asking. Plain keyword rules, English and Roman Urdu. Exported so it can be tested on its own. */
export function detectIntent(raw: string): string | null {
  const q = ` ${raw.toLowerCase().replace(/[^a-z0-9؀-ۿ\s]/g, " ").replace(/\s+/g, " ")} `;
  if (has(q, [" holiday", " eid ", " public off", "chutti kab", " chhutti kab", "چھٹی کب"])) return "next_holiday";
  if (has(q, [" leave", " leaves", " chutti", " chhutti", " rukhsat", "چھٹی", "رخصت"]) && has(q, ["balance", " left", "remain", "kitni", "kitne", "bachi", "bachay", "how many", "available", "باقی"])) return "leave_balance";
  if (has(q, [" manager", " boss", "report to", "reports to", " line manager", "mera manager", "مینیجر"])) return "manager";
  if (has(q, ["payslip", "pay slip", "paystub", "salary slip", "tankhwah", "tankhah", "salary", "تنخواہ"])) return "payslip";
  if (has(q, ["survey"])) return "surveys";
  if (has(q, [" sign", "to sign", "signature"])) return "to_sign";
  if (has(q, ["my question", "my ticket", "my request", "status of"])) return "my_questions";
  return null;
}

/**
 * Quick answers. A small set of questions answered from the asker's own records by fixed rules, in English or Roman Urdu. It is not an AI
 * chatbot and it invents nothing: anything it does not recognise gets a list of what it can answer and a link to ask HR. It never quotes pay figures.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService
  ) {}

  async ask(claims: RequestClaims, question: string): Promise<AssistantAnswer> {
    if (!(await this.entitlements.isModuleEnabled(claims, "employee"))) throw new NotFoundException();
    const q = (question ?? "").trim();
    if (!q || q.length > 300) throw new BadRequestException("Type a short question");
    const intent = detectIntent(q);
    return this.db.withClaims(claims, async (c) => {
      const me = (await c.query("SELECT id, manager_id FROM employees WHERE user_account_id = $1 ORDER BY (employment_status = 'active') DESC, created_at ASC LIMIT 1", [claims.sub])).rows[0];
      if (!me) throw new ForbiddenException("Your login is not linked to an employee record");
      switch (intent) {
        case "leave_balance": {
          const r = await c.query("SELECT leave_type, entitled_days, used_days FROM leave_balances WHERE employee_id = $1 AND year = $2 ORDER BY leave_type", [me.id, Number(localToday().slice(0, 4))]);
          if (!r.rowCount) return { intent, answer: "I could not find a leave balance for you this year. Open My Leave Requests, or ask HR.", link: "/app/leave/my-requests", linkLabel: "My Leave Requests" };
          const parts = r.rows.map((b) => `${b.leave_type}: ${Math.round((Number(b.entitled_days) - Number(b.used_days)) * 100) / 100} day(s) left of ${Number(b.entitled_days)}`);
          return { intent, answer: `Your leave this year (from your leave records): ${parts.join("; ")}.`, link: "/app/leave/my-requests", linkLabel: "My Leave Requests" };
        }
        case "next_holiday": {
          const h = (await c.query("SELECT name, holiday_date FROM holidays WHERE company_id = $1 AND holiday_date >= $2::date ORDER BY holiday_date LIMIT 3", [claims.company_id, localToday()])).rows;
          if (!h.length) return { intent, answer: "No upcoming holidays are set in your company's calendar yet.", link: null, linkLabel: null };
          return { intent, answer: `Next on your company calendar: ${h.map((x) => `${x.name} on ${new Date(x.holiday_date).toISOString().slice(0, 10)}`).join("; ")}.`, link: null, linkLabel: null };
        }
        case "manager": {
          if (!me.manager_id) return { intent, answer: "No manager is recorded for you. Ask HR if that looks wrong.", link: "/app/ess/helpdesk", linkLabel: "Ask HR" };
          const m = (await c.query("SELECT first_name, last_name FROM employees WHERE id = $1", [me.manager_id])).rows[0];
          return { intent, answer: m ? `Your manager on record is ${`${m.first_name} ${m.last_name}`.trim()}.` : "No manager is recorded for you.", link: "/app/ess/org-chart", linkLabel: "My Org Chart" };
        }
        case "payslip":
          return { intent, answer: "Your payslips are under My Paystubs. I do not read out pay figures here; open the payslip to see them.", link: "/app/ess/paystubs", linkLabel: "My Paystubs" };
        case "surveys": {
          const n = (await c.query("SELECT count(*)::int AS n FROM surveys s WHERE s.status = 'open' AND (s.closes_on IS NULL OR s.closes_on >= $2::date) AND NOT EXISTS (SELECT 1 FROM survey_participation p WHERE p.survey_id = s.id AND p.employee_id = $1)", [me.id, localToday()])).rows[0].n as number;
          return { intent, answer: n ? `You have ${n} survey${n === 1 ? "" : "s"} waiting. Answers are anonymous.` : "You have no surveys waiting.", link: "/app/ess/surveys", linkLabel: "Surveys" };
        }
        case "to_sign": {
          const n = (await c.query("SELECT count(*)::int AS n FROM esign_requests WHERE employee_id = $1 AND status = 'pending'", [me.id])).rows[0].n as number;
          return { intent, answer: n ? `You have ${n} document${n === 1 ? "" : "s"} waiting for you to read and sign.` : "You have no documents waiting to be signed.", link: "/app/ess/sign", linkLabel: "Documents to sign" };
        }
        case "my_questions": {
          const n = (await c.query("SELECT count(*)::int AS n FROM helpdesk_tickets WHERE employee_id = $1 AND status <> 'resolved'", [me.id])).rows[0].n as number;
          return { intent, answer: n ? `You have ${n} open question${n === 1 ? "" : "s"} with HR.` : "You have no open questions with HR.", link: "/app/ess/helpdesk", linkLabel: "Ask HR" };
        }
        default:
          return {
            intent: null,
            answer: "I can answer a few things from your own records: how much leave you have left, the next holiday, who your manager is, where your payslips are, and whether surveys or documents are waiting for you. For anything else, ask HR.",
            link: "/app/ess/helpdesk",
            linkLabel: "Ask HR",
          };
      }
    });
  }
}
