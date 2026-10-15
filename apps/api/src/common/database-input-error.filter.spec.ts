import { BadRequestException, Controller, Get, INestApplication, InternalServerErrorException, Param } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DatabaseInputErrorFilter, isClientInputDatabaseError } from "./database-input-error.filter";

/** LIVE-01: a malformed id reaching Postgres must answer 400, never 500; real faults still answer 500. */
@Controller("probe")
class ProbeController {
  /** Same shape node-postgres throws for `SELECT 'undefined'::uuid` (no database needed to prove the mapping). */
  @Get("uuid/:id")
  uuid(@Param("id") id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw Object.assign(new Error(`invalid input syntax for type uuid: "${id}"`), { code: "22P02", severity: "ERROR" });
    }
    return { ok: true };
  }

  @Get("boom")
  boom() {
    throw new Error("a real server fault");
  }

  @Get("http")
  http() {
    throw new BadRequestException("kept as is");
  }

  @Get("http500")
  http500() {
    throw new InternalServerErrorException("explicit 500");
  }
}

describe("DatabaseInputErrorFilter", () => {
  describe("isClientInputDatabaseError", () => {
    it("recognises the Postgres input-error codes only", () => {
      for (const code of ["22P02", "22007", "22008", "22003", "22001"]) expect(isClientInputDatabaseError({ code })).toBe(true);
      for (const code of ["23505", "42P01", "40001", "ECONNRESET"]) expect(isClientInputDatabaseError({ code })).toBe(false);
      expect(isClientInputDatabaseError(new BadRequestException())).toBe(false);
      expect(isClientInputDatabaseError(null)).toBe(false);
      expect(isClientInputDatabaseError(new Error("plain"))).toBe(false);
    });
  });

  describe("HTTP behaviour", () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ProbeController],
        providers: [{ provide: APP_FILTER, useClass: DatabaseInputErrorFilter }],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("answers 400 for a malformed uuid and never echoes the database message", async () => {
      const res = await request(app.getHttpServer()).get("/probe/uuid/undefined");
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not valid/i);
      expect(JSON.stringify(res.body)).not.toMatch(/uuid|syntax|22P02/i);
    });

    it("lets a well-formed uuid through", async () => {
      const res = await request(app.getHttpServer()).get("/probe/uuid/00000000-0000-0000-0000-000000000000");
      expect(res.status).toBe(200);
    });

    it("keeps real faults as 500 and explicit HTTP errors unchanged", async () => {
      expect((await request(app.getHttpServer()).get("/probe/boom")).status).toBe(500);
      const http = await request(app.getHttpServer()).get("/probe/http");
      expect(http.status).toBe(400);
      expect(http.body.message).toBe("kept as is");
      expect((await request(app.getHttpServer()).get("/probe/http500")).status).toBe(500);
    });
  });
});
