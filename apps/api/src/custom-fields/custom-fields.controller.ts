import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { CurrentClaims } from "../auth/current-claims.decorator";
import type { RequestClaims } from "../database/tenant-context";
import { CustomFieldsService } from "./custom-fields.service";
import { DefineCustomFieldDto, SetCustomFieldValueDto } from "./dto/custom-field.dto";

@Controller("custom-fields")
@UseGuards(SessionGuard)
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  @Post("definitions")
  define(@CurrentClaims() claims: RequestClaims, @Body() dto: DefineCustomFieldDto) {
    return this.customFields.defineField(claims, dto);
  }

  @Get("definitions")
  list(@CurrentClaims() claims: RequestClaims, @Query("objectKey") objectKey: string) {
    return this.customFields.listDefinitions(claims, objectKey);
  }

  @Post("values")
  setValue(@CurrentClaims() claims: RequestClaims, @Body() dto: SetCustomFieldValueDto) {
    return this.customFields.setValue(claims, { ...dto, value: dto.value ?? null });
  }

  @Get("values")
  getValues(
    @CurrentClaims() claims: RequestClaims,
    @Query("objectKey") objectKey: string,
    @Query("recordId") recordId: string
  ) {
    return this.customFields.getValues(claims, objectKey, recordId);
  }
}
