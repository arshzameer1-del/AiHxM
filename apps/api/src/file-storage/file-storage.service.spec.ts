import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalFileStorageService } from "./local-file-storage.service";

/**
 * `LocalFileStorageService` (the only `FileStorageService` implementation
 * that exists — see Decision #7 in file-storage.interface.ts) is pure
 * filesystem I/O with no Postgres dependency, so unlike every other
 * `*.service.spec.ts` in this codebase, this one needs no real Postgres
 * connection — it points the service at a throwaway temp directory
 * instead. Real callers (EmployeesService's document vault today) get
 * their own real-DB coverage in employees.service.spec.ts's "document
 * vault" tests; this file is about the storage layer itself: namespacing,
 * path-traversal safety, and the save/read/delete contract the interface
 * promises.
 */
describe("LocalFileStorageService", () => {
  let baseDir: string;
  let service: LocalFileStorageService;

  beforeAll(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "file-storage-spec-"));
    process.env.FILE_STORAGE_LOCAL_DIR = baseDir;
    // Constructor reads FILE_STORAGE_LOCAL_DIR once, synchronously — must
    // be constructed after the env var above is set.
    service = new LocalFileStorageService();
  });

  afterAll(async () => {
    delete process.env.FILE_STORAGE_LOCAL_DIR;
    await rm(baseDir, { recursive: true, force: true });
  });

  describe("save", () => {
    it("writes the buffer to disk under companyId/scope/ and returns storagePath + sizeBytes", async () => {
      const buffer = Buffer.from("hello world");
      const stored = await service.save("company-a", "scope-1", "resume.pdf", buffer);

      expect(stored.sizeBytes).toBe(buffer.byteLength);
      expect(stored.storagePath.startsWith("company-a/scope-1/")).toBe(true);
      expect(stored.storagePath.endsWith("resume.pdf")).toBe(true);

      const onDisk = await readFile(path.join(baseDir, stored.storagePath));
      expect(onDisk.equals(buffer)).toBe(true);
    });

    it("namespaces files under companyId/scope so two scopes never collide", async () => {
      const buffer = Buffer.from("a");
      const first = await service.save("company-a", "scope-1", "same-name.txt", buffer);
      const second = await service.save("company-a", "scope-2", "same-name.txt", buffer);

      expect(first.storagePath).not.toBe(second.storagePath);
      expect(first.storagePath.startsWith("company-a/scope-1/")).toBe(true);
      expect(second.storagePath.startsWith("company-a/scope-2/")).toBe(true);
    });

    it("gives every save its own random key, even for the same fileName and scope", async () => {
      const buffer = Buffer.from("dup");
      const a = await service.save("company-b", "scope-1", "dup.txt", buffer);
      const b = await service.save("company-b", "scope-1", "dup.txt", buffer);
      expect(a.storagePath).not.toBe(b.storagePath);
    });

    it("sanitizes a path-traversal fileName down to its basename, never escaping the base dir", async () => {
      const buffer = Buffer.from("traversal attempt");
      const stored = await service.save("company-c", "scope-1", "../../etc/passwd", buffer);

      expect(stored.storagePath).not.toContain("..");
      const resolved = path.resolve(baseDir, stored.storagePath);
      expect(resolved.startsWith(baseDir + path.sep)).toBe(true);
      expect(stored.storagePath.endsWith("passwd")).toBe(true);
    });

    it("replaces characters outside the safe fileName set with underscores", async () => {
      const buffer = Buffer.from("weird name");
      const stored = await service.save("company-c", "scope-1", "my file (final)!.docx", buffer);
      const fileNamePart = stored.storagePath.split("/").pop()!;

      expect(fileNamePart).not.toMatch(/[ ()!]/);
      expect(fileNamePart.endsWith(".docx")).toBe(true);
      expect(fileNamePart).toContain("final");
    });

    it("strips unsafe characters out of companyId/scope rather than rejecting the whole segment", async () => {
      const buffer = Buffer.from("x");
      const stored = await service.save("company/d!", "scope 1", "f.txt", buffer);
      expect(stored.storagePath.startsWith("companyd/scope1/")).toBe(true);
    });

    it("rejects a companyId or scope that sanitizes down to nothing", async () => {
      const buffer = Buffer.from("x");
      await expect(service.save("!!!", "scope-1", "f.txt", buffer)).rejects.toThrow("Invalid storage path segment");
      await expect(service.save("company-d", "###", "f.txt", buffer)).rejects.toThrow("Invalid storage path segment");
    });
  });

  describe("read", () => {
    it("reads back exactly what save() wrote", async () => {
      const buffer = Buffer.from("round trip bytes, including \x00 binary \xff junk");
      const stored = await service.save("company-e", "scope-1", "roundtrip.bin", buffer);
      const read = await service.read(stored.storagePath);
      expect(read.equals(buffer)).toBe(true);
    });

    it("rejects a storagePath that tries to escape the base directory", async () => {
      await expect(service.read("../outside.txt")).rejects.toThrow(
        "Refusing to resolve a storage path outside the configured storage directory"
      );
    });

    it("throws for a storagePath that was never written", async () => {
      await expect(service.read("company-e/scope-1/does-not-exist.txt")).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("removes a file that exists", async () => {
      const buffer = Buffer.from("to be deleted");
      const stored = await service.save("company-f", "scope-1", "delete-me.txt", buffer);
      await service.delete(stored.storagePath);
      await expect(service.read(stored.storagePath)).rejects.toThrow();
    });

    it("never throws when the file is already gone", async () => {
      await expect(service.delete("company-f/scope-1/never-existed.txt")).resolves.toBeUndefined();
    });

    it("rejects a storagePath that tries to escape the base directory", async () => {
      await expect(service.delete("../../etc/passwd")).rejects.toThrow(
        "Refusing to resolve a storage path outside the configured storage directory"
      );
    });
  });
});
