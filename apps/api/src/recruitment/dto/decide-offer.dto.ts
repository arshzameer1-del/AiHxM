import { IsIn } from "class-validator";

export class DecideOfferDto {
  @IsIn(["accepted", "declined"])
  decision!: "accepted" | "declined";
}
