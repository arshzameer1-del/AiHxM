import { IsIn, IsOptional, IsString } from "class-validator";

export class DecideOfferDto {
  @IsIn(["accepted", "declined"])
  decision!: "accepted" | "declined";

  @IsOptional()
  @IsString()
  reason?: string;
}
