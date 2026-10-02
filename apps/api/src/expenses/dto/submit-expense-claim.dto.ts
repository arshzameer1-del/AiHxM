import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID } from "class-validator";
import type { ExpenseCategory } from "@aihxm/shared-types";

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "travel",
  "meals",
  "accommodation",
  "office_supplies",
  "communication",
  "training",
  "other",
];

export class SubmitExpenseClaimDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(EXPENSE_CATEGORIES)
  category!: ExpenseCategory;

  @IsDateString()
  expenseDate!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
