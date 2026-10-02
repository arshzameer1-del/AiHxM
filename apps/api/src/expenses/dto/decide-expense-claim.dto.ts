import { IsIn, IsOptional, IsString } from "class-validator";

export class DecideExpenseClaimDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  comment?: string;
}
