import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateEmployeeLoginDto } from "./create-employee-login.dto";

async function errorsFor(roleKeys: string[]) {
  return validate(plainToInstance(CreateEmployeeLoginDto, { initialPassword: "Password@123456789", roleKeys }));
}

describe("CreateEmployeeLoginDto role keys", () => {
  it("accepts every role the Grant role(s) form offers, including Payroll Approver", async () => {
    const all = ["hr_admin", "line_manager", "employee_self_service", "ess_portal", "system_admin", "payroll_approver"];
    expect(await errorsFor(all)).toHaveLength(0);
    expect(await errorsFor(["payroll_approver"])).toHaveLength(0);
  });

  it("still refuses roles that are not tenant roles", async () => {
    expect((await errorsFor(["rbac_demo_viewer"])).length).toBeGreaterThan(0);
    expect((await errorsFor([])).length).toBeGreaterThan(0);
  });
});
