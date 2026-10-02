import { IsDateString, IsIn, IsObject, IsOptional } from "class-validator";
import type { PayrollFormulaExpression, PayrollFormulaKey } from "@aihxm/shared-types";

const FORMULA_KEYS: PayrollFormulaKey[] = ["income_tax", "eobi_employee", "eobi_employer"];

// `expression` is only checked to be an object here: its real validation
// (operator grammar + this key's allowed context variables) needs
// FormulaExpressionEngine.validate(), which PayrollFormulaOverridesService
// runs on every write — the same "DTO bounds at the HTTP boundary,
// authoritative check at the service boundary" split tax slabs use.

export class CreatePayrollFormulaDto {
  @IsIn(FORMULA_KEYS)
  formulaKey!: PayrollFormulaKey;

  @IsObject()
  expression!: PayrollFormulaExpression;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class UpdatePayrollFormulaDto {
  @IsObject()
  expression!: PayrollFormulaExpression;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class EndDatePayrollFormulaDto {
  @IsDateString()
  effectiveTo!: string;
}
