/**
 * Decision #7 (see DECISIONS.md): a small, storage-agnostic interface
 * standing in for Supabase Storage until a real Supabase project exists
 * (README's "Connecting a real Supabase project" section — this is one
 * more thing waiting on the account owner's own Supabase credentials).
 * Every caller (employees.service.ts's document vault today; any future
 * module needing file storage) depends on THIS interface, never on
 * `LocalFileStorageService` directly — swapping in a Supabase-Storage- or
 * S3-backed implementation later is a new class behind this same
 * interface, not a rewrite of the document vault feature. This is
 * Section 9's "no module depends on a Supabase-only convenience as its
 * only path" discipline applied in advance, before Supabase Storage is
 * even wired up once.
 */
export type StoredFile = {
  storagePath: string;
  sizeBytes: number;
};

export const FILE_STORAGE = Symbol("FILE_STORAGE");

export interface FileStorageService {
  /**
   * Persists `buffer` under a key namespaced by `companyId` (tenant
   * isolation at the storage layer too, not just in Postgres) and
   * `scope` (e.g. an employee id), returning the opaque `storagePath` the
   * caller should store in its own table — never assume its shape.
   */
  save(companyId: string, scope: string, fileName: string, buffer: Buffer): Promise<StoredFile>;

  /** Reads back exactly what `save()` wrote, by the `storagePath` it returned. */
  read(storagePath: string): Promise<Buffer>;

  /** Deletes the file at `storagePath`, if it exists. Never throws on "already gone." */
  delete(storagePath: string): Promise<void>;
}
