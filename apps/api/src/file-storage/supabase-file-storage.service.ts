import { Injectable } from "@nestjs/common";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { FileStorageService, StoredFile } from "./file-storage.interface";

/**
 * The real implementation Decision #7 (file-storage.interface.ts) was
 * always waiting on "once a real Supabase project exists" — it now does,
 * and this fixes a genuine production bug: `LocalFileStorageService`
 * writes under a directory on the API's own local disk
 * (`FILE_STORAGE_LOCAL_DIR`), which is exactly where Render's free web
 * service plan stores its filesystem — EPHEMERAL, wiped on every deploy
 * and every time a spun-down free instance cold-starts again. Every
 * upload through the old service (platform/tenant branding logos and
 * login backgrounds, employee document vault files) silently vanished
 * the next time the API redeployed or woke up, while the database kept
 * pointing at a `storagePath` that no longer existed on disk — reported
 * as "I uploaded a background logo from platform and it's still not
 * visible." Supabase Storage is an actual persistent object store, not
 * tied to the API container's own disk, so this is the permanent fix, not
 * a workaround — same posture as migration 0047's database-level email
 * constraint over relying on application code alone.
 *
 * Uses the SERVICE ROLE key deliberately, never the anon key — this is a
 * server-side-only client with no end user attached to it, the same trust
 * tier the API's own Postgres connection already runs at (DatabaseService
 * connects as the `app_role`/owner Postgres role directly, not through
 * Supabase's PostgREST/anon layer). The bucket is kept PRIVATE (no public
 * URL, no Storage RLS policy needed) because every caller of this
 * interface already re-implements its own access control in front of
 * `read()` — `PublicBrandingController` for the no-auth branding assets,
 * `PlatformAdminGuard`-gated routes for everything else — exactly
 * mirroring how `LocalFileStorageService` never exposed its files
 * directly either.
 */
@Injectable()
export class SupabaseFileStorageService implements FileStorageService {
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  /**
   * `testClient` exists only for supabase-file-storage.service.spec.ts —
   * constructing a real `SupabaseClient` around a fake URL/key and then
   * intercepting network calls is far more brittle than just handing this
   * a fake object shaped like the one `.storage.from(bucket)` call this
   * class actually makes. Every real caller (FileStorageModule) omits it.
   */
  constructor(testClient?: SupabaseClient) {
    if (testClient) {
      this.client = testClient;
      this.bucket = process.env.SUPABASE_STORAGE_BUCKET || "aihxm-files";
      return;
    }
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      // FileStorageModule only constructs this class once it has already
      // confirmed both env vars are set — this is a defense-in-depth
      // guard against a future refactor removing that check, not the
      // normal "not configured yet, fall back to local" path.
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set to use Supabase file storage");
    }
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET || "aihxm-files";
  }

  async save(companyId: string, scope: string, fileName: string, buffer: Buffer): Promise<StoredFile> {
    const safeCompanyId = sanitizeSegment(companyId);
    const safeScope = sanitizeSegment(scope);
    const safeFileName = sanitizeFileName(fileName);
    const key = `${safeCompanyId}/${safeScope}/${randomUUID()}-${safeFileName}`;

    const { error } = await this.client.storage.from(this.bucket).upload(key, buffer, {
      contentType: guessContentType(safeFileName),
      upsert: false,
    });
    if (error) {
      throw new Error(`Supabase Storage upload failed for "${key}": ${error.message}`);
    }
    return { storagePath: key, sizeBytes: buffer.byteLength };
  }

  async read(storagePath: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(storagePath);
    if (error || !data) {
      throw new Error(`Supabase Storage download failed for "${storagePath}": ${error?.message ?? "not found"}`);
    }
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(storagePath: string): Promise<void> {
    // Matches LocalFileStorageService's "never throws on already gone"
    // contract — Supabase Storage's own remove() already doesn't error on
    // a missing key, but this stays defensive against any error either
    // way (a transient network blip shouldn't fail whatever mutation is
    // deleting an old asset on the caller's behalf, e.g. an admin
    // re-uploading a logo).
    await this.client.storage.from(this.bucket).remove([storagePath]).catch(() => undefined);
  }
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned) throw new Error("Invalid storage path segment");
  return cleaned;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return base || "file";
}

// Supabase Storage's upload() doesn't sniff content type from the buffer
// the way a browser upload would — without this every download would come
// back as application/octet-stream, and downloadBrandingAsset/
// getBrandingAsset already trust the MIME type they separately recorded
// in company_config.branding, not this one, so this only needs to be
// reasonable, not authoritative.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

function guessContentType(fileName: string): string {
  return EXTENSION_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
