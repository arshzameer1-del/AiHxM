import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import type { EmployeeLetterType, EmployeeServiceRequestKind } from "@aihxm/shared-types";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { EmployeeRequestsService } from "./employee-requests.service";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class SubmitDto {
  @IsIn(["loan", "salary_advance", "letter", "leave_encashment"])
  kind!: EmployeeServiceRequestKind;

  @IsString()
  @MaxLength(1000)
  purpose!: string;

  @IsOptional()
  @Matches(DATE)
  neededBy?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  installmentsCount?: number;

  @IsOptional()
  @IsUUID()
  loanTypeId?: string;

  @IsOptional()
  @IsIn(["salary_certificate", "employment_letter", "experience_letter", "noc", "address_proof", "other"])
  letterType?: EmployeeLetterType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressedTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  leaveType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  leaveDays?: number;
}

class ApproveEncashmentDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @Matches(DATE)
  effectiveDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

class RejectDto {
  @IsString()
  @MaxLength(1000)
  note!: string;
}

class NoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

class ApproveLoanDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  principalAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  installmentsCount?: number;

  @IsOptional()
  @IsUUID()
  loanTypeId?: string;

  @IsOptional()
  @Matches(DATE)
  issuedDate?: string;

  @IsOptional()
  @Matches(DATE)
  deductionStartDate?: string;

  @IsOptional()
  @IsUUID()
  guarantorEmployeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** BACKLOG52 - employees ask HR for a loan, a salary advance or a letter; HR decides. */
@Controller("employee-requests")
@UseGuards(SessionGuard)
export class EmployeeRequestsController {
  constructor(private readonly requests: EmployeeRequestsService) {}

  @Post()
  submit(@CurrentClaims() claims: RequestClaims, @Body() dto: SubmitDto) {
    return this.requests.submit(claims, dto);
  }

  @Get("mine")
  mine(@CurrentClaims() claims: RequestClaims) {
    return this.requests.listMine(claims);
  }

  @Get("encashable-leave")
  encashableLeave(@CurrentClaims() claims: RequestClaims) {
    return this.requests.encashableLeave(claims);
  }

  @Post(":id/approve-encashment")
  approveEncashment(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ApproveEncashmentDto) {
    return this.requests.approveEncashment(claims, id, dto);
  }

  @Get("loan-types")
  loanTypes(@CurrentClaims() claims: RequestClaims) {
    return this.requests.requestableLoanTypes(claims);
  }

  @Get()
  list(@CurrentClaims() claims: RequestClaims, @Query("status") status?: string, @Query("kind") kind?: string) {
    return this.requests.list(claims, { status, kind });
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.requests.cancel(claims, id);
  }

  @Post(":id/reject")
  reject(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RejectDto) {
    return this.requests.reject(claims, id, dto.note);
  }

  @Post(":id/approve-loan")
  approveLoan(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: ApproveLoanDto) {
    return this.requests.approveLoan(claims, id, dto);
  }

  @Post(":id/issue-salary-certificate")
  issueSalaryCertificate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: NoteDto) {
    return this.requests.issueSalaryCertificate(claims, id, dto);
  }

  @Post(":id/issue-letter")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  issueLetter(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: NoteDto, @UploadedFile() file: Express.Multer.File) {
    return this.requests.issueLetter(claims, id, file, dto.note);
  }
}
