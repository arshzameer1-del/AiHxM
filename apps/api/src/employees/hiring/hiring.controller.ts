import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import type { UpdateCardDefinitionRequest, UpdateCardFieldConfigRequest } from "@aihxm/shared-types";
import { IdempotencyKey } from "../../idempotency/idempotency-key.decorator";
import { SessionGuard } from "../../auth/session.guard";
import { CurrentClaims } from "../../auth/current-claims.decorator";
import type { RequestClaims } from "../../database/tenant-context";
import { HiringProcessService } from "./hiring-process.service";
import { CardFieldConfigService } from "./card-field-config.service";
import { SaveHireProcessCardDto } from "./dto/save-hire-process-card.dto";
import { AdvanceHireProcessDto } from "./dto/advance-hire-process.dto";
import { UpdateHiringConfigurationDto } from "./dto/update-hiring-configuration.dto";
import { UpdateCardFieldConfigDto } from "./dto/update-card-field-config.dto";
import { AddCardCustomFieldDto } from "./dto/add-card-custom-field.dto";
import { RejectHireProcessDto, SetHireDelegateDto, StartHireProcessDto, TransferHireOwnershipDto } from "./dto/hire-process-workflow.dto";

/**
 * Core Employee Enterprise Phase 2/3 — the spec's own Section 37 API list,
 * mapped onto this codebase's existing `/employees` resource rather than
 * a separate `/core-employees` root (this IS the employee domain, not a
 * parallel one — Section 2's ownership boundary is Core Employee vs.
 * Organization Management, not this codebase's own route naming).
 *
 * `hiring/drafts` is declared before `hiring/:id` for the same reason
 * EmployeesController declares `org-chart` before `:id` — Nest matches
 * routes in declaration order.
 */
@Controller("employees/hiring")
@UseGuards(SessionGuard)
export class HiringController {
  constructor(private readonly hiring: HiringProcessService) {}

  @Post()
  start(@CurrentClaims() claims: RequestClaims, @Body() dto: StartHireProcessDto, @IdempotencyKey() idempotencyKey?: string) {
    return this.hiring.start(claims, dto ?? {}, idempotencyKey);
  }

  @Get("drafts")
  listDrafts(@CurrentClaims() claims: RequestClaims) {
    return this.hiring.listDrafts(claims);
  }

  @Get(":id")
  get(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.get(claims, id);
  }

  @Get(":id/cards")
  async listCards(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return (await this.hiring.get(claims, id)).cards;
  }

  @Get(":id/cards/:cardKey")
  getCardData(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Param("cardKey") cardKey: string) {
    return this.hiring.getCardData(claims, id, cardKey);
  }

  @Put(":id/cards/:cardKey")
  saveCard(
    @CurrentClaims() claims: RequestClaims,
    @Param("id") id: string,
    @Param("cardKey") cardKey: string,
    @Body() dto: SaveHireProcessCardDto
  ) {
    return this.hiring.saveCard(claims, id, cardKey, dto);
  }

  @Post(":id/draft")
  draft(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.draft(claims, id);
  }

  @Post(":id/next")
  next(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AdvanceHireProcessDto) {
    return this.hiring.next(claims, id, dto.expectedRevision);
  }

  @Post(":id/cancel")
  cancel(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: AdvanceHireProcessDto) {
    return this.hiring.cancel(claims, id, dto.expectedRevision);
  }

  @Post(":id/complete")
  complete(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.complete(claims, id);
  }

  /** CFG-08: re-validate every saved card against the current rules. */
  @Post(":id/validate")
  validate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.validate(claims, id);
  }

  @Post(":id/submit")
  submit(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.submit(claims, id);
  }

  @Post(":id/approve")
  approve(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.approve(claims, id);
  }

  @Post(":id/reject")
  reject(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: RejectHireProcessDto) {
    return this.hiring.reject(claims, id, dto.reason);
  }

  @Get(":id/history")
  history(@CurrentClaims() claims: RequestClaims, @Param("id") id: string) {
    return this.hiring.getStatusHistory(claims, id);
  }

  /** CFG-09: ownership transfer and delegate. */
  @Post(":id/owner")
  transferOwner(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: TransferHireOwnershipDto) {
    return this.hiring.transferOwnership(claims, id, dto.ownerUserAccountId, dto.reason);
  }

  @Put(":id/delegate")
  setDelegate(@CurrentClaims() claims: RequestClaims, @Param("id") id: string, @Body() dto: SetHireDelegateDto) {
    return this.hiring.setDelegate(claims, id, dto.delegateUserAccountId);
  }
}

/** Configuration Center — Phase 3's own scoped admin surface. Separate controller (different base route), same service. */
@Controller("configuration/core-employee/hiring")
@UseGuards(SessionGuard)
export class HiringConfigurationController {
  constructor(
    private readonly hiring: HiringProcessService,
    private readonly cardFields: CardFieldConfigService
  ) {}

  @Get()
  list(@CurrentClaims() claims: RequestClaims) {
    return this.hiring.listCardDefinitions(claims);
  }

  @Put()
  async update(@CurrentClaims() claims: RequestClaims, @Body() dto: UpdateHiringConfigurationDto) {
    const results = [];
    for (const entry of dto.cards) {
      results.push(await this.hiring.updateCardDefinition(claims, entry.cardKey, entry as UpdateCardDefinitionRequest));
    }
    return results;
  }

  // Hiring Card Field Configuration (2026-09-27) — kumail's own request,
  // one level deeper than the card-level toggles above: field-level
  // enable/disable/required for a single card's built-in fields, plus
  // "add custom field". See `CardFieldConfigService`'s own doc comment.
  @Get(":cardKey/fields")
  listFields(@CurrentClaims() claims: RequestClaims, @Param("cardKey") cardKey: string) {
    return this.cardFields.listCardFields(claims, cardKey);
  }

  @Put(":cardKey/fields/:fieldKey")
  updateField(
    @CurrentClaims() claims: RequestClaims,
    @Param("cardKey") cardKey: string,
    @Param("fieldKey") fieldKey: string,
    @Body() dto: UpdateCardFieldConfigDto
  ) {
    return this.cardFields.updateFieldConfig(claims, cardKey, fieldKey, dto as UpdateCardFieldConfigRequest);
  }

  @Post(":cardKey/fields/custom")
  addCustomField(@CurrentClaims() claims: RequestClaims, @Param("cardKey") cardKey: string, @Body() dto: AddCardCustomFieldDto) {
    return this.cardFields.addCustomField(claims, cardKey, dto);
  }

  @Delete(":cardKey/fields/custom/:fieldKey")
  deactivateCustomField(@CurrentClaims() claims: RequestClaims, @Param("cardKey") cardKey: string, @Param("fieldKey") fieldKey: string) {
    return this.cardFields.deactivateCustomField(claims, cardKey, fieldKey);
  }
}
