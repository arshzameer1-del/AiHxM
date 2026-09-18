import { IsIn, IsOptional, IsString } from "class-validator";

export class DecideOnDutyRequestDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  comment?: string;
}
