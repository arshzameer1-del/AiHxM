import { Module } from "@nestjs/common";
import { FILE_STORAGE, type FileStorageService } from "./file-storage.interface";
import { LocalFileStorageService } from "./local-file-storage.service";
import { SupabaseFileStorageService } from "./supabase-file-storage.service";

/**
 * Picks the real Supabase-Storage-backed implementation whenever
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are actually set (production,
 * once the account owner has filled in Render's blueprint secrets and
 * created the bucket — see SupabaseFileStorageService's doc comment for
 * why this swap exists), and falls back to the local-disk implementation
 * otherwise — every dev machine and the test suite (neither sets those
 * two vars — see apps/api/.env's blank SUPABASE_* lines) keeps working
 * exactly as before, no real Supabase project required just to run
 * `npm test`.
 */
function createFileStorageService(): FileStorageService {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseFileStorageService();
  }
  return new LocalFileStorageService();
}

@Module({
  providers: [{ provide: FILE_STORAGE, useFactory: createFileStorageService }],
  exports: [FILE_STORAGE],
})
export class FileStorageModule {}
