import { IsIn, IsOptional, IsString } from "class-validator";

export class DecideAttendanceCorrectionDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";

  @IsOptional()
  @IsString()
  comment?: string;
}
