import type { LeaveValidationRuleView } from "@aihxm/shared-types";
import { LeaveValidationRulesService } from "./leave-validation-rules.service";

const svc = Object.create(LeaveValidationRulesService.prototype) as LeaveValidationRulesService;
const rule = (over: Partial<LeaveValidationRuleView>): LeaveValidationRuleView =>
  ({
    id: "r", code: "c", name: "Rule", description: null, validationType: "balance_sufficient", leaveTypes: [], policyIds: [], employeeGroupIds: [],
    severity: "block", message: "m", messages: {}, adminExplanation: null, priority: 1000, effectiveFrom: null, effectiveTo: null, isActive: true,
    allowProceed: false, conditions: null, params: {}, isSystem: false, isLocked: false, version: 1, updatedAt: "", ...over,
  }) as LeaveValidationRuleView;

describe("shadowNotices (gap 15)", () => {
  const builtIn = rule({ id: "b", name: "Built-in", priority: 1000, severity: "block" });

  it("warns when a lenient rule runs ahead of a stricter one it overlaps", () => {
    const lenient = rule({ id: "n", name: "Lenient", priority: 100, severity: "warning" });
    const notices = svc.shadowNotices(lenient, [builtIn, lenient]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Built-in");
  });

  it("stays quiet when the stricter rule runs first, the scopes do not overlap, or the types differ", () => {
    expect(svc.shadowNotices(rule({ id: "n", priority: 2000, severity: "warning" }), [builtIn])).toEqual([]);
    expect(svc.shadowNotices(rule({ id: "n", priority: 100, severity: "warning", leaveTypes: ["annual"] }), [rule({ ...builtIn, leaveTypes: ["sick"] })])).toEqual([]);
    expect(svc.shadowNotices(rule({ id: "n", priority: 100, severity: "warning", validationType: "notice_period" as never }), [builtIn])).toEqual([]);
    expect(svc.shadowNotices(rule({ id: "n", priority: 100, severity: "warning", isActive: false }), [builtIn])).toEqual([]);
  });

  it("an equally strict or stricter rule ahead is fine", () => {
    expect(svc.shadowNotices(rule({ id: "n", priority: 100, severity: "block" }), [builtIn])).toEqual([]);
  });
});
