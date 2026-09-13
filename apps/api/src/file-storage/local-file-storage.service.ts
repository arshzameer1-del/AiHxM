import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { FileStorageService, StoredFile } from "./file-storage.interface";

/**
 * The only `FileStorageService` implementation that exists today (see
 * Decision #7) — writes under a base directory (`FILE_STORAGE_LOCAL_DIR`,
 * default `./storage-data`, gitignored) namespaced `companyId/scope/`.
 * `storagePath` is always the path RELATIVE to that base directory (never
 * an absolute host path leaked into the database), and every path
 * component is either a caller-supplied UUID or a randomly generated one
 * plus a sanitized filename — never the raw, attacker-controllable
 * `fileName` alone — so a path-traversal attempt (`../../etc/passwd`)
 * can't escape the base directory.
 */
@Injectable()
export class LocalFileStorageService implements FileStorageService {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = path.resolve(process.env.FILE_STORAGE_LOCAL_DIR ?? "./storage-data");
  }

  async save(companyId: string, scope: string, fileName: string, buffer: Buffer): Promise<StoredFile> {
    const safeCompanyId = sanitizeSegment(companyId);
    const safeScope = sanitizeSegment(scope);
    const safeFileName = sanitizeFileName(fileName);
    const key = `${safeCompanyId}/${safeScope}/${randomUUID()}-${safeFileName}`;
    const fullPath = this.resolveWithinBase(key);

    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, buffer);
    return { storagePath: key, sizeBytes: buffer.byteLength };
  }

  async read(storagePath: string): Promise<Buffer> {
    return readFile(this.resolveWithinBase(storagePath));
  }

  async delete(storagePath: string): Promise<void> {
    await rm(this.resolveWithinBase(storagePath), { force: true });
  }

  /** Resolves a stored relative key against the base dir, refusing anything that would escape it. */
  private resolveWithinBase(storagePath: string): string {
    const fullPath = path.resolve(this.baseDir, storagePath);
    if (fullPath !== this.baseDir && !fullPath.startsWith(this.baseDir + path.sep)) {
      throw new Error("Refusing to resolve a storage path outside the configured storage directory");
    }
    return fullPath;
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
