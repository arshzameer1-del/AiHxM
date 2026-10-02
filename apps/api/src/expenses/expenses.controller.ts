import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { ExpenseClaimsService } from "./expense-claims.service";
import { SubmitExpenseClaimDto } from "./dto/submit-expense-claim.dto";
import { DecideExpenseClaimDto } from "./dto/decide-expense-claim.dto";

/**
 * Any real session can call these (SessionGuard) — ExpenseClaimsService's
 * own entitlement + permission (and, for decisions, workflow-routing)
 * checks are what actually decide who succeeds, same split every module
 * since Phase 4 has used (identical posture to LeaveController).
 */
@Controller()
@UseGuards(SessionGuard)
export class ExpensesController {
  constructor(private readonly expenseClaims: ExpenseClaimsService) {}

  @Post("expense-claims")
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitExpenseClaimDto) {
    return this.expenseClaims.submit(claims, dto);
  }

  @Get("expense-claims")
  list(@CurrentClaims() claims: RequestClaims, @Query("employeeId") employeeId?: string) {
    return this.expenseClaims.listClaims(claims, { employeeId });
  }

  @Get("expense-claims/:id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.expenseClaims.getClaim(claims, id);
  }

  @Patch("expense-claims/:id/decision")
  decide(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: DecideExpenseClaimDto) {
    return this.expenseClaims.decide(claims, id, dto);
  }

  @Post("expense-claims/:id/mark-paid")
  markPaid(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.expenseClaims.markPaid(claims, id);
  }

  @Post("expense-claims/:id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.expenseClaims.cancel(claims, id);
  }

  @Post("expense-claims/:id/receipts")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadReceipt(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File
  ) {
    return this.expenseClaims.addReceipt(claims, id, file);
  }

  @Get("expense-claims/:id/receipts/:receiptId")
  async downloadReceipt(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("receiptId") receiptId: string,
    @Res() res: Response
  ) {
    const { buffer, fileName, mimeType } = await this.expenseClaims.downloadReceipt(claims, id, receiptId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(buffer);
  }
}
