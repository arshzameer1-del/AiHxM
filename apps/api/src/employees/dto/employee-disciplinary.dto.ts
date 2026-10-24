import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { DisciplinaryRecordType } from "@aihxm/shared-types";

const TYPES: DisciplinaryRecordType[] = ["verbal_warning", "written_warning", "final_warning", "show_cause", "suspension", "other"];

export class CreateEmployeeDisciplinaryRecordDto {
  @IsUUID() employeeId!: string;
  @IsIn(TYPES) recordType!: DisciplinaryRecordType;
  @IsString() @MinLength(2) @MaxLength(200) subject!: string;
  @IsString() @MinLength(2) @MaxLength(4000) description!: string;
  @IsOptional() @IsDateString() incidentDate?: string | null;
  @IsOptional() @IsDateString() issuedDate?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) actionTaken?: string | null;
}

export class WithdrawDisciplinaryRecordDto {
  @IsString() @MinLength(2) @MaxLength(1000) reason!: string;
}

export class AcknowledgeDisciplinaryRecordDto {
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}
