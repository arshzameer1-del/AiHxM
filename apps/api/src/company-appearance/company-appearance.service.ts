import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  HOME_BANNER_PRESETS,
  isDarkEnoughForWhiteText,
  type CompanyAppearanceView,
  type HomeBannerMode,
  type HomeBannerPresetKey,
  type UpdateCompanyAppearanceRequest,
} from "@aihxm/shared-types";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { FILE_STORAGE, type FileStorageService } from "../file-storage/file-storage.interface";
import { RbacService } from "../rbac/rbac.service";

export const MANAGE_APPEARANCE = "company_appearance.manage";
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_BANNER_BYTES = 2 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(row: any | undefined): CompanyAppearanceView {
  return {
    bannerMode: (row?.banner_mode ?? "default") as HomeBannerMode,
    bannerPreset: (row?.banner_preset ?? null) as HomeBannerPresetKey | null,
    bannerColor: row?.banner_color ?? null,
    hasBannerImage: Boolean(row?.banner_image_path),
    photoNeedsHrApproval: row?.photo_needs_hr_approval ?? false,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * BACKLOG55 - the company-wide look a System Admin controls: the home banner background (standard / preset / colour /
 * uploaded picture) and whether employee profile photos wait for HR. Everybody in the company can read it (the banner is
 * drawn for each person); changing it needs company_appearance.manage, which System Admin holds and any custom role can be given.
 */
@Injectable()
export class CompanyAppearanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageService
  ) {}

  async get(claims: RequestClaims): Promise<CompanyAppearanceView> {
    if (!claims.company_id) return toView(undefined);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM company_appearance WHERE company_id = $1", [claims.company_id]);
      return toView(r.rows[0]);
    });
  }

  async update(claims: RequestClaims, input: UpdateCompanyAppearanceRequest): Promise<CompanyAppearanceView> {
    await this.requireManage(claims);
    if (input.bannerPreset && !HOME_BANNER_PRESETS.some((p) => p.key === input.bannerPreset)) {
      throw new BadRequestException("Choose one of the listed banner styles");
    }
    if (input.bannerColor && !isDarkEnoughForWhiteText(input.bannerColor)) {
      throw new BadRequestException("That colour is too light for the white text on the banner. Choose a darker one.");
    }
    return this.db.withClaims(claims, async (client) => {
      const cur = (await client.query("SELECT * FROM company_appearance WHERE company_id = $1", [claims.company_id])).rows[0];
      const mode = input.bannerMode ?? (cur?.banner_mode as HomeBannerMode | undefined) ?? "default";
      const preset = input.bannerPreset !== undefined ? input.bannerPreset : cur?.banner_preset ?? null;
      const color = input.bannerColor !== undefined ? input.bannerColor : cur?.banner_color ?? null;
      if (mode === "preset" && !preset) throw new BadRequestException("Choose a banner style");
      if (mode === "color" && !color) throw new BadRequestException("Choose a banner colour");
      if (mode === "image" && !cur?.banner_image_path) throw new BadRequestException("Upload a picture first");
      const actor = claims.sub && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
      const r = await client.query(
        `INSERT INTO company_appearance (company_id, banner_mode, banner_preset, banner_color, photo_needs_hr_approval, updated_by_user_account_id)
         VALUES ($1, $2, $3, $4, COALESCE($5, false), $6)
         ON CONFLICT (company_id) DO UPDATE SET banner_mode = $2, banner_preset = $3, banner_color = $4,
           photo_needs_hr_approval = COALESCE($5, company_appearance.photo_needs_hr_approval),
           updated_by_user_account_id = $6, updated_at = now()
         RETURNING *`,
        [claims.company_id, mode, preset, color, input.photoNeedsHrApproval ?? null, actor]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "company_appearance.update",
        target: claims.company_id!,
        metadata: { bannerMode: mode, bannerPreset: preset, bannerColor: color, photoNeedsHrApproval: r.rows[0].photo_needs_hr_approval },
      });
      return toView(r.rows[0]);
    });
  }

  async uploadBannerImage(claims: RequestClaims, file: { originalname: string; mimetype: string; buffer: Buffer; size: number } | undefined): Promise<CompanyAppearanceView> {
    await this.requireManage(claims);
    if (!file) throw new BadRequestException("Choose a picture to upload");
    if (!IMAGE_MIMES.includes(file.mimetype)) throw new BadRequestException("The banner picture must be a JPEG, PNG or WEBP image");
    if (file.size > MAX_BANNER_BYTES) throw new BadRequestException("The banner picture must be 2 MB or smaller");
    const stored = await this.storage.save(claims.company_id!, "appearance", file.originalname, file.buffer);
    const old = await this.db.withClaims(claims, async (client) => {
      const prev = (await client.query("SELECT banner_image_path FROM company_appearance WHERE company_id = $1", [claims.company_id])).rows[0];
      const actor = claims.sub && /^[0-9a-f-]{36}$/i.test(claims.sub) ? claims.sub : null;
      await client.query(
        `INSERT INTO company_appearance (company_id, banner_image_path, banner_image_mime, updated_by_user_account_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id) DO UPDATE SET banner_image_path = $2, banner_image_mime = $3, updated_by_user_account_id = $4, updated_at = now()`,
        [claims.company_id, stored.storagePath, file.mimetype, actor]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "company_appearance.banner_image", target: claims.company_id!, metadata: { mime: file.mimetype, bytes: file.size } });
      return prev?.banner_image_path as string | undefined;
    });
    if (old && old !== stored.storagePath) await this.storage.delete(old);
    return this.get(claims);
  }

  async removeBannerImage(claims: RequestClaims): Promise<CompanyAppearanceView> {
    await this.requireManage(claims);
    const old = await this.db.withClaims(claims, async (client) => {
      const prev = (await client.query("SELECT banner_image_path FROM company_appearance WHERE company_id = $1", [claims.company_id])).rows[0];
      await client.query(
        `UPDATE company_appearance SET banner_image_path = NULL, banner_image_mime = NULL,
           banner_mode = CASE WHEN banner_mode = 'image' THEN 'default' ELSE banner_mode END, updated_at = now() WHERE company_id = $1`,
        [claims.company_id]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "company_appearance.banner_image_removed", target: claims.company_id! });
      return prev?.banner_image_path as string | undefined;
    });
    if (old) await this.storage.delete(old);
    return this.get(claims);
  }

  async bannerImage(claims: RequestClaims): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!claims.company_id) throw new NotFoundException();
    const row = await this.db.withClaims(claims, async (client) =>
      (await client.query("SELECT banner_image_path, banner_image_mime FROM company_appearance WHERE company_id = $1", [claims.company_id])).rows[0]
    );
    if (!row?.banner_image_path) throw new NotFoundException("No banner picture");
    return { buffer: await this.storage.read(row.banner_image_path), mimeType: row.banner_image_mime };
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id || !(await this.rbac.can(claims, MANAGE_APPEARANCE))) {
      throw new ForbiddenException("Not permitted to change the company appearance");
    }
  }
}
