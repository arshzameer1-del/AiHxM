import { IsInt, Min } from "class-validator";

/** Used by both `next` and `cancel` — Section 25's optimistic lock on the hire process itself. */
export class AdvanceHireProcessDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}
