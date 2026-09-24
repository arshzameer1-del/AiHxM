import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseFileStorageService } from "./supabase-file-storage.service";

/**
 * A fake shaped exactly like the one surface of the real SupabaseClient
 * this service touches (`.storage.from(bucket).upload/download/remove`) —
 * see the constructor's doc comment for why this is preferred over
 * mocking the `@supabase/supabase-js` module itself.
 */
function fakeSupabaseClient(overrides?: {
  upload?: jest.Mock;
  download?: jest.Mock;
  remove?: jest.Mock;
}): { client: SupabaseClient; from: jest.Mock } {
  const upload = overrides?.upload ?? jest.fn().mockResolvedValue({ data: { path: "x" }, error: null });
  const download = overrides?.download ?? jest.fn();
  const remove = overrides?.remove ?? jest.fn().mockResolvedValue({ data: [], error: null });
  const from = jest.fn().mockReturnValue({ upload, download, remove });
  return { client: { storage: { from } } as unknown as SupabaseClient, from };
}

describe("SupabaseFileStorageService", () => {
  afterEach(() => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
  });

  describe("save", () => {
    it("uploads under companyId/scope/<uuid>-fileName and returns storagePath + sizeBytes", async () => {
      const { client, from } = fakeSupabaseClient();
      const service = new SupabaseFileStorageService(client);
      const buffer = Buffer.from("hello world");

      const stored = await service.save("company-a", "scope-1", "resume.pdf", buffer);

      expect(stored.sizeBytes).toBe(buffer.byteLength);
      expect(stored.storagePath.startsWith("company-a/scope-1/")).toBe(true);
      expect(stored.storagePath.endsWith("resume.pdf")).toBe(true);
      expect(from).toHaveBeenCalledWith("aihxm-files");
    });

    it("uses the SUPABASE_STORAGE_BUCKET env var when set, instead of the default", async () => {
      process.env.SUPABASE_STORAGE_BUCKET = "custom-bucket";
      const { client, from } = fakeSupabaseClient();
      const service = new SupabaseFileStorageService(client);

      await service.save("company-a", "scope-1", "logo.png", Buffer.from("x"));

      expect(from).toHaveBeenCalledWith("custom-bucket");
    });

    it("sanitizes a path-traversal fileName down to its basename", async () => {
      const { client } = fakeSupabaseClient();
      const service = new SupabaseFileStorageService(client);

      const stored = await service.save("company-c", "scope-1", "../../etc/passwd", Buffer.from("x"));

      expect(stored.storagePath).not.toContain("..");
      expect(stored.storagePath.endsWith("passwd")).toBe(true);
    });

    it("throws a descriptive error when Supabase reports an upload failure", async () => {
      const upload = jest.fn().mockResolvedValue({ data: null, error: { message: "bucket not found" } });
      const { client } = fakeSupabaseClient({ upload });
      const service = new SupabaseFileStorageService(client);

      await expect(service.save("company-a", "scope-1", "f.png", Buffer.from("x"))).rejects.toThrow(
        "bucket not found"
      );
    });
  });

  describe("read", () => {
    it("reads back the bytes Supabase Storage returns", async () => {
      const original = Buffer.from("round trip bytes");
      const download = jest.fn().mockResolvedValue({
        data: { arrayBuffer: async () => original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) },
        error: null,
      });
      const { client } = fakeSupabaseClient({ download });
      const service = new SupabaseFileStorageService(client);

      const read = await service.read("company-a/scope-1/key-file.txt");

      expect(read.equals(original)).toBe(true);
    });

    it("throws when Supabase reports the file is missing", async () => {
      const download = jest.fn().mockResolvedValue({ data: null, error: { message: "Object not found" } });
      const { client } = fakeSupabaseClient({ download });
      const service = new SupabaseFileStorageService(client);

      await expect(service.read("company-a/scope-1/does-not-exist.txt")).rejects.toThrow("Object not found");
    });
  });

  describe("delete", () => {
    it("calls remove() with the storagePath", async () => {
      const remove = jest.fn().mockResolvedValue({ data: [], error: null });
      const { client } = fakeSupabaseClient({ remove });
      const service = new SupabaseFileStorageService(client);

      await service.delete("company-a/scope-1/key-file.txt");

      expect(remove).toHaveBeenCalledWith(["company-a/scope-1/key-file.txt"]);
    });

    it("never throws, even if the remove call itself rejects", async () => {
      const remove = jest.fn().mockRejectedValue(new Error("network blip"));
      const { client } = fakeSupabaseClient({ remove });
      const service = new SupabaseFileStorageService(client);

      await expect(service.delete("company-a/scope-1/whatever.txt")).resolves.toBeUndefined();
    });
  });
});
